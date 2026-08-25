/**
 * Sonda de diagnóstico: ¿devuelve la API Cumulus los datos del sensor Instinct?
 *
 * Uso:
 *   npm run login      (una vez, crea logindata.json)
 *   npx tsx src/probe.ts
 *
 * Guarda la respuesta COMPLETA en cumulus-response.json (en local, para ti) y
 * por pantalla imprime sólo un resumen SIN datos personales.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { discoverBaseUrls, CumulusClient } from './carelink/cumulus.js';
import { loadLoginData, saveLoginData, isTokenExpired, refreshToken } from './carelink/token.js';
import type { CareLinkData } from './types/carelink.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

dotenv.config({ path: path.join(ROOT, 'my.env') });
dotenv.config({ path: path.join(ROOT, '.env') });

const LOGINDATA = path.join(ROOT, 'logindata.json');
const OUTFILE = path.join(ROOT, 'cumulus-response.json');

function line(): void {
  console.log('─'.repeat(64));
}

async function main(): Promise<void> {
  const isUS = (process.env['MMCONNECT_SERVER'] || 'EU').toUpperCase() !== 'EU';

  line();
  console.log('  SONDA CUMULUS  ·  región:', isUS ? 'US' : 'EU');
  line();

  // --- Token ---------------------------------------------------------------
  let loginData = loadLoginData(LOGINDATA);
  if (!loginData) {
    console.error('✗ No hay logindata.json. Ejecuta primero:  npm run login');
    process.exit(1);
  }
  if (isTokenExpired(loginData.access_token)) {
    console.log('· Token caducado, refrescando…');
    loginData = await refreshToken(loginData);
    saveLoginData(LOGINDATA, loginData);
  }
  console.log('✓ Token válido');

  // --- Discovery -----------------------------------------------------------
  const urls = await discoverBaseUrls(isUS);
  console.log('✓ Discovery OK');
  console.log('    baseUrlCareLink:', urls.baseUrlCareLink);
  console.log('    baseUrlCumulus :', urls.baseUrlCumulus);

  const client = new CumulusClient(loginData, urls);

  // --- Paso 1: quién soy ---------------------------------------------------
  const user = await client.getUser();
  const role = (user.role || '(sin rol)').toUpperCase();
  console.log('✓ /users/me OK  ·  rol =', role);
  if (user.mfaRequired) console.log('  ⚠ La cuenta tiene MFA activado (no soportado)');

  const isCarePartner = role.includes('CARE_PARTNER') || role.includes('CAREPARTNER');
  if (!isCarePartner) {
    console.log('  ⚠ ESTO NO ES UNA CUENTA DE CARE PARTNER.');
    console.log('    Con la cuenta de paciente, /display/message suele dar 204.');
  }

  // --- Paso 2: pacientes vinculados ---------------------------------------
  if (isCarePartner) {
    const patients = await client.getLinkedPatients();
    console.log(`✓ /links/patients OK  ·  ${patients.length} paciente(s) vinculado(s)`);
    if (patients.length === 0) {
      console.error('✗ Sin pacientes vinculados: aprueba la solicitud en MiniMed Go.');
      process.exit(1);
    }
  }

  // --- Paso 3: los datos ---------------------------------------------------
  line();
  console.log('  Llamando a /display/message …');
  line();

  const result = await client.fetchRecent(process.env['CARELINK_PATIENT'] || undefined);
  const data: CareLinkData = result.data;

  fs.writeFileSync(OUTFILE, JSON.stringify(data, null, 2));

  // --- Resumen sin datos personales ---------------------------------------
  const sgs = Array.isArray(data.sgs) ? data.sgs : [];
  const withValue = sgs.filter(s => typeof s?.sg === 'number' && s.sg > 0);

  console.log('✓ RESPUESTA RECIBIDA');
  console.log('    claves        :', Object.keys(data).length);
  console.log('    familia disp. :', data.medicalDeviceFamily || data.deviceFamily || '(ninguna)');
  console.log('    estado sensor :', data.sensorState || '(ninguno)');
  console.log('    unidades      :', data.bgUnits || data.bgunits || '(ninguna)');
  console.log('    lecturas (sgs):', sgs.length, `(${withValue.length} con valor)`);
  console.log('    último valor  :', data.lastSG?.sg ?? '(ninguno)');
  console.log('    hora último   :', data.lastSG?.datetime ?? '(ninguna)');
  console.log('    tendencia     :', data.lastSGTrend ?? '(ninguna)');
  console.log('    sensor en rango:', data.conduitSensorInRange ?? '(desconocido)');

  line();
  const ok = withValue.length > 0 || (typeof data.lastSG?.sg === 'number' && data.lastSG.sg > 0);
  if (ok) {
    console.log('  ✅ ÉXITO: la API Cumulus DEVUELVE datos de glucosa.');
    console.log('     El bridge es viable. Respuesta completa en cumulus-response.json');
  } else {
    console.log('  ⚠ Conecta y responde, pero SIN valores de glucosa.');
    console.log('     Revisa cumulus-response.json para ver qué trae.');
  }
  line();
}

main().catch((err: unknown) => {
  const e = err as { response?: { status: number; data?: unknown }; message?: string };
  line();
  console.error('✗ FALLO');
  if (e.response?.status) {
    console.error('  HTTP', e.response.status);
    if (e.response.status === 204) {
      console.error('  204 = autenticado pero sin contenido.');
      console.error('  Casi siempre: estás usando la cuenta de PACIENTE.');
      console.error('  Hace falta la cuenta de CARE PARTNER (la de CareLink Connect).');
    }
    if (e.response.status === 401) {
      console.error('  401 = token inválido/caducado. Borra logindata.json y repite npm run login');
    }
    if (e.response.data) {
      const body = typeof e.response.data === 'string'
        ? e.response.data.slice(0, 300)
        : JSON.stringify(e.response.data).slice(0, 300);
      console.error('  cuerpo:', body);
    }
  } else {
    console.error(' ', e.message);
  }
  line();
  process.exit(1);
});
