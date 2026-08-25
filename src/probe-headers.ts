/**
 * v11 y v13 responden 206 {"message":"Upgrade application"}.
 * El SSO config es idéntico para 3.6 y 3.8, así que el token NO lleva la versión.
 * Conclusión: la versión viaja en una cabecera (o en el body).
 *
 * Este script prueba variantes hasta que el mensaje cambie.
 *
 * Uso: npx tsx src/probe-headers.ts
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import dotenv from 'dotenv';
import { discoverBaseUrls, CumulusClient } from './carelink/cumulus.js';
import { loadLoginData, saveLoginData, isTokenExpired, refreshToken } from './carelink/token.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const URL_V13 = 'https://clcloud.minimed.eu/connect/carepartner/v13/display/message';
const DALVIK = 'Dalvik/2.1.0 (Linux; U; Android 10; Nexus 5X Build/QQ3A.200805.001)';

interface Variant {
  name: string;
  headers?: Record<string, string>;
  bodyExtra?: Record<string, string>;
}

const VARIANTS: Variant[] = [
  { name: 'base (Dalvik, sin extras)' },
  { name: 'UA CareLinkConnect/3.8', headers: { 'User-Agent': 'CareLinkConnect/3.8 (Android 14)' } },
  { name: 'UA com.medtronic.carepartner/3.8', headers: { 'User-Agent': 'com.medtronic.carepartner/3.8 (Android 14; okhttp/4.12.0)' } },
  { name: 'UA okhttp/4.12.0', headers: { 'User-Agent': 'okhttp/4.12.0' } },
  { name: 'hdr x-app-version: 3.8', headers: { 'x-app-version': '3.8' } },
  { name: 'hdr app-version: 3.8', headers: { 'app-version': '3.8' } },
  { name: 'hdr client-version: 3.8', headers: { 'client-version': '3.8' } },
  { name: 'hdr x-client-version: 3.8', headers: { 'x-client-version': '3.8' } },
  { name: 'hdr appVersion+os', headers: { appVersion: '3.8', os: 'android' } },
  { name: 'hdr x-carelink-app-version: 3.8', headers: { 'x-carelink-app-version': '3.8' } },
  { name: 'body clientVersion 3.8', bodyExtra: { clientVersion: '3.8' } },
  { name: 'body appVersion+os', bodyExtra: { appVersion: '3.8', os: 'android' } },
  { name: 'combo UA+hdr+body', headers: { 'User-Agent': 'com.medtronic.carepartner/3.8 (Android 14; okhttp/4.12.0)', 'x-app-version': '3.8', appVersion: '3.8', os: 'android' }, bodyExtra: { clientVersion: '3.8', appVersion: '3.8' } },
];

function describe(status: number, data: unknown): string {
  if (data == null || data === '') return '(cuerpo vacío)';
  if (typeof data === 'object') {
    const o = data as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && typeof o['message'] === 'string') return `message="${o['message']}"`;
    const sgs = Array.isArray(o['sgs']) ? (o['sgs'] as unknown[]).length : null;
    const last = (o['lastSG'] as { sg?: number } | undefined)?.sg;
    return `${keys.length} claves${sgs !== null ? `, sgs=${sgs}` : ''}${last ? `, lastSG=${last}` : ''}`;
  }
  return String(data).slice(0, 100);
}

async function main(): Promise<void> {
  const LOGIN = path.join(ROOT, 'logindata.json');
  let loginData = loadLoginData(LOGIN);
  if (!loginData) throw new Error('Falta logindata.json');
  if (isTokenExpired(loginData.access_token)) {
    loginData = await refreshToken(loginData);
    saveLoginData(LOGIN, loginData);
  }

  const urls = await discoverBaseUrls(false);
  const client = new CumulusClient(loginData, urls);
  const user = await client.getUser();
  const role = (user.role || '').toUpperCase();
  const isCP = role.includes('CARE_PARTNER') || role.includes('CAREPARTNER');
  const patients = isCP ? await client.getLinkedPatients() : [];
  const patientId = process.env['CARELINK_PATIENT'] || patients[0]?.username;

  const baseBody: Record<string, string> = {
    username: user.username || '',
    role: isCP ? 'carepartner' : 'patient',
  };
  if (patientId) baseBody.patientId = patientId;

  console.log('Probando', VARIANTS.length, 'variantes contra v13/display/message');
  console.log('─'.repeat(78));

  for (const v of VARIANTS) {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': DALVIK,
      Authorization: 'Bearer ' + loginData.access_token,
      ...(v.headers || {}),
    };
    const body = { ...baseBody, ...(v.bodyExtra || {}) };

    try {
      const resp = await axios.post(URL_V13, body, { headers, timeout: 20_000, validateStatus: () => true });
      const desc = describe(resp.status, resp.data);
      const hit = desc.includes('claves');
      console.log(`${v.name.padEnd(34)} ${String(resp.status).padEnd(4)} ${desc}${hit ? '  ◀── ¡DATOS!' : ''}`);
      if (hit) {
        fs.writeFileSync(path.join(ROOT, 'cumulus-hit.json'), JSON.stringify({ variant: v, data: resp.data }, null, 2));
        console.log('\n✅ Guardado en cumulus-hit.json');
        return;
      }
    } catch (e) {
      console.log(`${v.name.padEnd(34)} ERR  ${(e as Error).message.slice(0, 60)}`);
    }
  }
  console.log('─'.repeat(78));
  console.log('Ninguna variante desbloqueó los datos.');
}

main().catch(e => { console.error('FALLO:', (e as Error).message); process.exit(1); });
