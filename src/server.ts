/**
 * Servidor compatible con la API de Nightscout, alimentado por la API Cumulus
 * de CareLink (sensor MiniMed Instinct / MiniMed Go).
 *
 * xDrip+ se configura como "Nightscout Follower" apuntando a este servidor,
 * y de ahí sale hacia WatchDrip+ y la pulsera.
 *
 * Endpoints:
 *   GET /api/v1/status.json        estado (xDrip lo consulta al conectar)
 *   GET /api/v1/entries.json       lecturas (alias: /api/v1/entries/sgv.json)
 *   GET /health                    diagnóstico legible
 *
 * Sin dependencias nuevas: usa node:http.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { discoverBaseUrls, CumulusClient, type CumulusBaseUrls } from './carelink/cumulus.js';
import { isTokenExpired, refreshToken } from './carelink/token.js';
import type { CareLinkData, CareLinkSG, LoginData } from './types/carelink.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const PORT = Number(process.env['PORT'] || 3000);
const POLL_MS = Number(process.env['POLL_INTERVAL'] || 120) * 1000;
const IS_US = (process.env['MMCONNECT_SERVER'] || 'EU').toUpperCase() !== 'EU';
const API_SECRET = process.env['API_SECRET'] || '';
const PATIENT = process.env['CARELINK_PATIENT'] || undefined;

/**
 * Railway borra el disco en cada despliegue. Para no perder el refresh_token:
 *  - DATA_DIR (volumen) es la fuente de verdad si existe,
 *  - LOGINDATA_JSON (variable de entorno) sirve de semilla inicial.
 */
const DATA_DIR = process.env['DATA_DIR'] || ROOT;
const LOGIN_PATH = path.join(DATA_DIR, 'logindata.json');

function loadLogin(): LoginData {
  if (fs.existsSync(LOGIN_PATH)) {
    return JSON.parse(fs.readFileSync(LOGIN_PATH, 'utf8')) as LoginData;
  }
  const seed = process.env['LOGINDATA_JSON'];
  if (seed) {
    const parsed = JSON.parse(seed) as LoginData;
    persistLogin(parsed);
    return parsed;
  }
  throw new Error(
    'No hay credenciales: falta logindata.json y la variable LOGINDATA_JSON.',
  );
}

function persistLogin(data: LoginData): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LOGIN_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[token] No se pudo persistir logindata.json:', (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Estado en memoria
// ---------------------------------------------------------------------------
interface Cache {
  data: CareLinkData | null;
  fetchedAt: number;
  lastError: string | null;
  consecutiveErrors: number;
}
const cache: Cache = { data: null, fetchedAt: 0, lastError: null, consecutiveErrors: 0 };
let baseUrls: CumulusBaseUrls | null = null;

/**
 * Las lecturas de Cumulus vienen SIN zona horaria y en hora local del paciente
 * (patientData.clientTimeZoneName). Las interpretamos con el desfase que el
 * propio servidor de CareLink reporta, comparando su hora local con currentServerTime.
 */
function toEpochMs(sg: CareLinkSG, offsetMs: number): number {
  const raw = sg.timestamp || sg.datetime;
  if (!raw) return 0;
  // Date.parse sobre "2026-08-25T15:47:48" lo trata como hora LOCAL del proceso.
  // Forzamos UTC añadiendo la Z y restamos el offset real del paciente.
  const asUtc = Date.parse(raw.endsWith('Z') ? raw : raw + 'Z');
  return Number.isNaN(asUtc) ? 0 : asUtc - offsetMs;
}

/** Desfase horario del paciente en ms, deducido de la propia respuesta. */
function patientOffsetMs(data: CareLinkData): number {
  const serverNow = Number(data['currentServerTime']);
  const localStr = data['lastConduitDateTime'] as string | undefined;
  if (!serverNow || !localStr) return 0;
  const localAsUtc = Date.parse(localStr + 'Z');
  if (Number.isNaN(localAsUtc)) return 0;
  // Redondeado a media hora: las zonas horarias reales son múltiplos de 30 min.
  const rawOffset = localAsUtc - serverNow;
  return Math.round(rawOffset / 1_800_000) * 1_800_000;
}

const TREND_MAP: Record<string, string> = {
  NONE: 'Flat',
  UP: 'SingleUp',
  UP_DOUBLE: 'DoubleUp',
  UP_TRIPLE: 'DoubleUp',
  DOWN: 'SingleDown',
  DOWN_DOUBLE: 'DoubleDown',
  DOWN_TRIPLE: 'DoubleDown',
};

interface NsEntry {
  _id: string;
  type: 'sgv';
  sgv: number;
  date: number;
  dateString: string;
  direction: string;
  device: string;
}

function buildEntries(data: CareLinkData): NsEntry[] {
  const offsetMs = patientOffsetMs(data);
  const sgs = Array.isArray(data.sgs) ? data.sgs : [];
  const direction = TREND_MAP[String(data.lastSGTrend || 'NONE')] || 'Flat';
  const device = 'MiniMedGo-Instinct';

  const entries = sgs
    .filter(s => s && s.kind === 'SG' && typeof s.sg === 'number' && s.sg > 0)
    .map(s => {
      const date = toEpochMs(s, offsetMs);
      return {
        _id: crypto.createHash('md5').update(`${date}-${s.sg}`).digest('hex').slice(0, 24),
        type: 'sgv' as const,
        sgv: s.sg,
        date,
        dateString: new Date(date).toISOString(),
        // Sólo la lectura más reciente conoce su tendencia real.
        direction: 'Flat',
        device,
      };
    })
    .filter(e => e.date > 0)
    .sort((a, b) => b.date - a.date); // Nightscout devuelve de más nueva a más vieja

  if (entries.length > 0) entries[0].direction = direction;
  return entries;
}

// ---------------------------------------------------------------------------
// Consulta a CareLink
// ---------------------------------------------------------------------------
async function poll(): Promise<void> {
  try {
    let login = loadLogin();
    if (isTokenExpired(login.access_token)) {
      login = await refreshToken(login);
      persistLogin(login);
    }
    if (!baseUrls) baseUrls = await discoverBaseUrls(IS_US);

    const client = new CumulusClient(login, baseUrls);
    const result = await client.fetchRecent(PATIENT);

    cache.data = result.data;
    cache.fetchedAt = Date.now();
    cache.lastError = null;
    cache.consecutiveErrors = 0;

    const n = Array.isArray(result.data.sgs) ? result.data.sgs.length : 0;
    console.log(`[poll] OK · ${n} lecturas · última=${result.data.lastSG?.sg ?? '?'}`);
  } catch (e) {
    cache.consecutiveErrors++;
    cache.lastError = (e as Error).message;
    console.error(`[poll] fallo #${cache.consecutiveErrors}:`, cache.lastError);
  }
}

// ---------------------------------------------------------------------------
// Autenticación de lectura
// ---------------------------------------------------------------------------
/** Nightscout manda el secreto como SHA1 hex en la cabecera api-secret. */
function authorized(req: http.IncomingMessage, url: URL): boolean {
  if (!API_SECRET) return true; // sin secreto configurado, lectura abierta

  const token = url.searchParams.get('token');
  if (token && token === API_SECRET) return true;

  const header = req.headers['api-secret'];
  if (typeof header === 'string') {
    const sha1 = crypto.createHash('sha1').update(API_SECRET).digest('hex');
    if (header.toLowerCase() === sha1 || header === API_SECRET) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function json(res: http.ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (p === '/health' || p === '/') {
    const ageS = cache.fetchedAt ? Math.round((Date.now() - cache.fetchedAt) / 1000) : null;
    return json(res, cache.data ? 200 : 503, {
      ok: !!cache.data,
      lastFetchSecondsAgo: ageS,
      readings: Array.isArray(cache.data?.sgs) ? cache.data!.sgs.length : 0,
      lastSG: cache.data?.lastSG?.sg ?? null,
      lastError: cache.lastError,
      consecutiveErrors: cache.consecutiveErrors,
    });
  }

  if (!authorized(req, url)) {
    return json(res, 401, { status: 401, message: 'Unauthorized' });
  }

  if (p === '/api/v1/status.json' || p === '/api/v1/status') {
    return json(res, 200, {
      status: 'ok',
      name: 'carelink-cumulus-bridge',
      version: '0.1.0',
      serverTime: new Date().toISOString(),
      serverTimeEpoch: Date.now(),
      apiEnabled: true,
      careportalEnabled: false,
      boluscalcEnabled: false,
      settings: {
        units: cache.data?.bgUnits === 'MMOLL' ? 'mmol' : 'mg/dl',
        timeFormat: 24,
      },
      extendedSettings: {},
      authorized: null,
    });
  }

  if (p === '/api/v1/entries.json' || p === '/api/v1/entries/sgv.json' || p === '/api/v1/entries') {
    if (!cache.data) {
      return json(res, 503, { status: 503, message: 'Sin datos todavía', error: cache.lastError });
    }
    const count = Math.min(Number(url.searchParams.get('count') || 100) || 100, 1000);
    return json(res, 200, buildEntries(cache.data).slice(0, count));
  }

  return json(res, 404, { status: 404, message: 'Not found' });
});

async function main(): Promise<void> {
  console.log('[init] región:', IS_US ? 'US' : 'EU', '· intervalo:', POLL_MS / 1000, 's');
  console.log('[init] auth de lectura:', API_SECRET ? 'API_SECRET activo' : 'ABIERTA (sin secreto)');

  await poll();
  setInterval(() => { void poll(); }, POLL_MS);

  server.listen(PORT, () => console.log(`[init] escuchando en :${PORT}`));
}

main().catch(e => { console.error('FATAL:', (e as Error).message); process.exit(1); });
