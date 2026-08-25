/**
 * El PR #4711 de xDrip+ manda appVersion="3.8.0" (con .0) en el body.
 * Nosotros verificamos "3.8" (sin .0). ¿Acepta el servidor ambos formatos?
 *
 * Si sólo vale "3.8", el PR fallaría y conviene avisar antes de que
 * alguien compile un APK para nada.
 *
 * Uso: npx tsx src/probe-appversion.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import dotenv from 'dotenv';
import { discoverBaseUrls, CumulusClient } from './carelink/cumulus.js';
import { loadLoginForProbe } from './carelink/local-token.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const DALVIK = 'Dalvik/2.1.0 (Linux; U; Android 10; Nexus 5X Build/QQ3A.200805.001)';

/** Valores de appVersion a probar, con os=android siempre presente. */
const VERSIONS = ['3.7', '3.6.9', '3.6.1', '3.5.0', '10.0.0'];

function describe(data: unknown): string {
  if (data == null || data === '') return '(vacío)';
  if (typeof data === 'object') {
    const o = data as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && typeof o['message'] === 'string') return `RECHAZO: "${o['message']}"`;
    const pd = o['patientData'] as Record<string, unknown> | undefined;
    const sgs = Array.isArray(pd?.['sgs']) ? (pd!['sgs'] as unknown[]).length : null;
    const last = (pd?.['lastSG'] as { sg?: number } | undefined)?.sg;
    return `OK · ${keys.length} claves` + (sgs !== null ? `, sgs=${sgs}` : '') + (last ? `, lastSG=${last}` : '');
  }
  return String(data).slice(0, 80);
}

async function main(): Promise<void> {
  const LOGIN = path.join(ROOT, 'logindata.json');
  const loginData = loadLoginForProbe(LOGIN);

  const urls = await discoverBaseUrls(false);
  const client = new CumulusClient(loginData, urls);
  const user = await client.getUser();
  const role = (user.role || '').toUpperCase();
  const isCP = role.includes('CARE_PARTNER') || role.includes('CAREPARTNER');
  const patients = isCP ? await client.getLinkedPatients() : [];
  const patientId = process.env['CARELINK_PATIENT'] || patients[0]?.username;

  const url = `${urls.baseUrlCumulus}/display/message`;
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': DALVIK,
    Authorization: 'Bearer ' + loginData.access_token,
  };

  console.log('POST', url);
  console.log('(os="android" en todas; sólo varía appVersion)');
  console.log('─'.repeat(66));

  for (const v of VERSIONS) {
    const body: Record<string, string> = {
      username: user.username || '',
      role: isCP ? 'carepartner' : 'patient',
      appVersion: v,
      os: 'android',
    };
    if (patientId) body.patientId = patientId;

    try {
      const resp = await axios.post(url, body, { headers, timeout: 20_000, validateStatus: () => true });
      console.log(`appVersion="${v}"`.padEnd(24) + `HTTP ${resp.status}  ` + describe(resp.data));
    } catch (e) {
      console.log(`appVersion="${v}"`.padEnd(24) + 'ERROR ' + (e as Error).message.slice(0, 50));
    }
  }

  // Control: sin os, para confirmar que sigue siendo obligatorio.
  const noOs: Record<string, string> = {
    username: user.username || '',
    role: isCP ? 'carepartner' : 'patient',
    appVersion: '3.8.0',
  };
  if (patientId) noOs.patientId = patientId;
  const r = await axios.post(url, noOs, { headers, timeout: 20_000, validateStatus: () => true });
  console.log('─'.repeat(66));
  console.log('control (3.8.0 SIN os)'.padEnd(24) + `HTTP ${r.status}  ` + describe(r.data));
}

main().catch(e => { console.error('FALLO:', (e as Error).message); process.exit(1); });
