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
 * A partir de aquí los datos se consideran rancios y /health devuelve 503.
 * Por defecto 15 min: el sensor da una lectura por minuto y la nube tarda ~4,5,
 * así que pasado ese margen algo va mal de verdad.
 */
const STALE_AFTER_S = Number(process.env['STALE_AFTER'] || 900);

/**
 * Railway borra el disco en cada despliegue. Para no perder el refresh_token:
 *  - DATA_DIR (volumen) es la fuente de verdad si existe,
 *  - LOGINDATA_JSON (variable de entorno) sirve de semilla inicial.
 */
const DATA_DIR = process.env['DATA_DIR'] || ROOT;
const LOGIN_PATH = path.join(DATA_DIR, 'logindata.json');

/** La semilla inmutable que el usuario controla desde las variables de entorno. */
function loadSeed(): LoginData | null {
  const seed = process.env['LOGINDATA_JSON'];
  if (!seed) return null;
  try {
    return JSON.parse(seed) as LoginData;
  } catch (e) {
    console.error('[token] LOGINDATA_JSON no es JSON válido:', (e as Error).message);
    return null;
  }
}

/**
 * Marcador de semillas ya consumidas.
 *
 * Guardamos un hash del refresh_token, no el token: si alguien mira el volumen
 * no encuentra credenciales reutilizables.
 */
const SEED_MARK_PATH = path.join(DATA_DIR, 'seed-used.txt');

function seedFingerprint(seed: LoginData): string {
  return crypto.createHash('sha256').update(seed.refresh_token).digest('hex').slice(0, 32);
}

function seedAlreadyUsed(seed: LoginData): boolean {
  try {
    if (!fs.existsSync(SEED_MARK_PATH)) return false;
    return fs.readFileSync(SEED_MARK_PATH, 'utf8').trim() === seedFingerprint(seed);
  } catch {
    return false; // ante la duda, permitir el intento: es una sola vez
  }
}

function markSeedUsed(seed: LoginData): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SEED_MARK_PATH, seedFingerprint(seed));
  } catch (e) {
    console.error('[token] No se pudo marcar la semilla como usada:', (e as Error).message);
  }
}

function loadLogin(): LoginData {
  if (fs.existsSync(LOGIN_PATH)) {
    return JSON.parse(fs.readFileSync(LOGIN_PATH, 'utf8')) as LoginData;
  }
  const seed = loadSeed();
  if (seed) {
    persistLogin(seed);
    return seed;
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

/** Offset real de una zona IANA en un instante dado (respeta horario de verano). */
function offsetForZone(zone: string, atMs: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(atMs));
    const get = (t: string): number => Number(parts.find(p => p.type === t)?.value);
    const asUtc = Date.UTC(
      get('year'), get('month') - 1, get('day'),
      get('hour') % 24, get('minute'), get('second'),
    );
    return Number.isNaN(asUtc) ? null : asUtc - atMs;
  } catch {
    return null; // zona desconocida para el runtime
  }
}

/**
 * Desfase horario del paciente en ms.
 *
 * Fuente preferida: `clientTimeZoneName` (p. ej. "Europe/Madrid"), que es un dato
 * estable y respeta el horario de verano.
 *
 * ⚠️ ANTES se deducía comparando `lastConduitDateTime` con `currentServerTime`, y eso
 * era un bug: `lastConduitDateTime` es la última vez que el móvil habló con la nube.
 * Si el móvil lleva horas sin subir (caída, sin cobertura, app bloqueada), ese campo
 * se congela y el offset sale desviado por esas mismas horas. Consecuencia real:
 * lecturas emitidas con timestamp FUTURO y xDrip+ rechazándolas con
 * "bgreading is too far in the future", además de envenenar su base de datos.
 */
function patientOffsetMs(data: CareLinkData): number {
  const zone = data['clientTimeZoneName'] as string | undefined;
  if (zone) {
    const off = offsetForZone(zone, Date.now());
    if (off !== null) return off;
  }

  // Respaldo: la heurística antigua, pero sólo si el conduit está reciente.
  const serverNow = Number(data['currentServerTime']);
  const localStr = data['lastConduitDateTime'] as string | undefined;
  if (!serverNow || !localStr) return 0;
  const localAsUtc = Date.parse(localStr + 'Z');
  if (Number.isNaN(localAsUtc)) return 0;

  const rawOffset = localAsUtc - serverNow;
  // Ninguna zona real pasa de ±14 h: fuera de eso el dato está rancio, no desfasado.
  if (Math.abs(rawOffset) > 14 * 3_600_000) {
    console.warn('[tz] lastConduitDateTime parece rancio; usando offset 0');
    return 0;
  }
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
    // Red de seguridad: una lectura con fecha futura envenena la base de datos de
    // xDrip+ ("bgreading is too far in the future") y deja de aceptar las posteriores.
    // Mejor descartarla que servir algo imposible. 2 min de margen por desfases de reloj.
    .filter(e => e.date > 0 && e.date <= Date.now() + 120_000)
    .sort((a, b) => b.date - a.date); // Nightscout devuelve de más nueva a más vieja

  if (entries.length > 0) entries[0].direction = direction;
  return entries;
}

// ---------------------------------------------------------------------------
// Consulta a CareLink
// ---------------------------------------------------------------------------
/** Reintento con espera creciente: no tiene sentido insistir cada minuto si está revocado. */
let nextAllowedPoll = 0;

async function poll(): Promise<void> {
  if (Date.now() < nextAllowedPoll) return;
  try {
    let login = loadLogin();
    if (isTokenExpired(login.access_token)) {
      try {
        login = await refreshToken(login);
        persistLogin(login);
      } catch (err) {
        // El refresh token guardado puede estar REVOCADO, no sólo caducado.
        // Auth0 rota los refresh tokens y, si detecta que uno ya usado se
        // reutiliza (típico si corres una copia local contra la misma cuenta),
        // invalida toda la familia. A partir de ahí el token del volumen es
        // basura y sólo se recupera con un login nuevo.
        //
        // Si el usuario ya ha actualizado LOGINDATA_JSON, lo usamos y nos
        // recuperamos solos, sin tener que borrar el volumen a mano.
        const seed = loadSeed();
        if (!seed || seed.refresh_token === login.refresh_token) {
          console.error(
            '[token] Refresh rechazado y la semilla LOGINDATA_JSON es la misma. ' +
            'Hace falta un "npm run login" nuevo y actualizar la variable.',
          );
          throw err;
        }
        // Una semilla sólo se puede usar UNA vez: los refresh tokens de Auth0 se
        // gastan al usarse. Reintentar una semilla ya consumida es reutilización,
        // y eso mantiene revocada la familia entera — justo lo que convierte un
        // fallo puntual en una caída permanente. Pasó: 524 fallos seguidos.
        if (seedAlreadyUsed(seed)) {
          console.error(
            '[token] La semilla LOGINDATA_JSON ya se consumió y el refresh sigue fallando.\n' +
            '        Hace falta un login nuevo:\n' +
            '          1) rm logindata.json && npm run login\n' +
            '          2) actualizar la variable LOGINDATA_JSON con el fichero nuevo\n' +
            '        No se reintentará con esta semilla para no reutilizar el token.',
          );
          throw err;
        }
        console.warn('[token] Refresh rechazado; adoptando la semilla LOGINDATA_JSON (un solo intento)…');
        markSeedUsed(seed);
        login = isTokenExpired(seed.access_token) ? await refreshToken(seed) : seed;
        persistLogin(login);
        console.log('[token] Recuperado con la semilla nueva.');
      }
    }
    if (!baseUrls) baseUrls = await discoverBaseUrls(IS_US);

    const client = new CumulusClient(login, baseUrls);
    const result = await client.fetchRecent(PATIENT);

    cache.data = result.data;
    cache.fetchedAt = Date.now();
    cache.lastError = null;
    cache.consecutiveErrors = 0;
    nextAllowedPoll = 0;

    const n = Array.isArray(result.data.sgs) ? result.data.sgs.length : 0;
    console.log(`[poll] OK · ${n} lecturas · última=${result.data.lastSG?.sg ?? '?'}`);
  } catch (e) {
    cache.consecutiveErrors++;
    cache.lastError = (e as Error).message;

    // Espera creciente hasta 15 min. Insistir cada minuto contra un token
    // revocado no lo resucita, sólo llena los logs y castiga a la API.
    if (cache.consecutiveErrors >= 3) {
      const waitMs = Math.min(POLL_MS * 2 ** (cache.consecutiveErrors - 2), 15 * 60_000);
      nextAllowedPoll = Date.now() + waitMs;
      console.error(
        `[poll] fallo #${cache.consecutiveErrors}: ${cache.lastError} ` +
        `· siguiente intento en ${Math.round(waitMs / 1000)}s`,
      );
    } else {
      console.error(`[poll] fallo #${cache.consecutiveErrors}:`, cache.lastError);
    }
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
    // "Tener datos" no es estar sano: hay que tenerlos FRESCOS.
    // Antes devolvía 200 con datos de 8 horas y ningún monitor se enteraba.
    const fresh = ageS !== null && ageS <= STALE_AFTER_S;
    const healthy = !!cache.data && fresh;
    return json(res, healthy ? 200 : 503, {
      ok: healthy,
      stale: !fresh,
      staleAfterSeconds: STALE_AFTER_S,
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
