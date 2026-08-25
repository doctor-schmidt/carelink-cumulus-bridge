/**
 * El endpoint v13 responde {"message":"Upgrade application"}.
 * Este script prueba /display/message contra varias versiones de Cumulus
 * para encontrar cuál acepta nuestro cliente.
 *
 * Uso: npx tsx src/probe-versions.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import dotenv from 'dotenv';
import { discoverBaseUrls, CumulusClient } from './carelink/cumulus.js';
import { loadLoginForProbe } from './carelink/local-token.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const ANDROID_UA = 'Dalvik/2.1.0 (Linux; U; Android 10; Nexus 5X Build/QQ3A.200805.001)';
const HOST = 'https://clcloud.minimed.eu/connect/carepartner';
const VERSIONS = ['v2', 'v3', 'v5', 'v6', 'v10', 'v11', 'v12', 'v13'];

function summarize(data: unknown): string {
  if (data == null) return '(vacío)';
  if (typeof data === 'string') return data.slice(0, 120);
  const obj = data as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && typeof obj['message'] === 'string') {
    return `message="${obj['message']}"`;
  }
  const sgs = Array.isArray(obj['sgs']) ? (obj['sgs'] as unknown[]).length : null;
  const lastSG = obj['lastSG'] as { sg?: number } | undefined;
  return `${keys.length} claves` +
    (sgs !== null ? `, sgs=${sgs}` : '') +
    (lastSG?.sg ? `, lastSG=${lastSG.sg}` : '');
}

async function main(): Promise<void> {
  const loginData = loadLoginForProbe(path.join(ROOT, 'logindata.json'));

  // Reutilizamos el cliente para resolver rol y patientId una sola vez.
  const urls = await discoverBaseUrls(false);
  const client = new CumulusClient(loginData, urls);
  const user = await client.getUser();
  const role = (user.role || '').toUpperCase();
  const isCP = role.includes('CARE_PARTNER') || role.includes('CAREPARTNER');
  const patients = isCP ? await client.getLinkedPatients() : [];
  const patientId = process.env['CARELINK_PATIENT'] || patients[0]?.username;
  const apiRole = isCP ? 'carepartner' : 'patient';

  console.log('rol =', role, '| pacientes vinculados =', patients.length);
  console.log('─'.repeat(70));

  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': ANDROID_UA,
    Authorization: 'Bearer ' + loginData.access_token,
  };
  const body: Record<string, string> = { username: user.username || '', role: apiRole };
  if (patientId) body.patientId = patientId;

  for (const v of VERSIONS) {
    const url = `${HOST}/${v}/display/message`;
    try {
      const resp = await axios.post(url, body, {
        headers,
        timeout: 20_000,
        validateStatus: () => true,
      });
      const mark = resp.status === 200 && summarize(resp.data).includes('claves') ? ' ◀── ¡DATOS!' : '';
      console.log(`${v.padEnd(4)} HTTP ${resp.status}  ${summarize(resp.data)}${mark}`);

      if (mark) {
        fs.writeFileSync(
          path.join(ROOT, `cumulus-response-${v}.json`),
          JSON.stringify(resp.data, null, 2),
        );
      }
    } catch (e) {
      console.log(`${v.padEnd(4)} ERROR  ${(e as Error).message.slice(0, 80)}`);
    }
  }
  console.log('─'.repeat(70));
}

main().catch(e => {
  console.error('FALLO:', (e as Error).message);
  process.exit(1);
});
