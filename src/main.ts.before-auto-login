import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', 'my.env') });
dotenv.config();

import { loadConfig } from './config.js';
import { transform } from './transform/index.js';
import { makeRecencyFilter } from './filter.js';
import { upload } from './nightscout/upload.js';
import * as logger from './logger.js';
import { login, LOGINDATA_FILE } from './login.js';
import { discoverBaseUrls, CumulusClient } from './carelink/cumulus.js';
import type { NightscoutSGVEntry, NightscoutDeviceStatus } from './types/nightscout.js';

const config = loadConfig();
logger.setVerbose(config.verbose);

const baseUrl = config.nsBaseUrl || ('https://' + config.nsHost);
const entriesUrl = baseUrl + '/api/v1/entries.json';
const devicestatusUrl = baseUrl + '/api/v1/devicestatus.json';

const filterSgvs = makeRecencyFilter<NightscoutSGVEntry>(item => item.date);

const filterDeviceStatus = makeRecencyFilter<NightscoutDeviceStatus>(
  item => new Date(item.created_at).getTime(),
);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function uploadIfNew(items: unknown[], endpoint: string): Promise<void> {
  if (items.length === 0) {
    console.log('[Bridge] No new items for', endpoint);
    return;
  }

  console.log('[Bridge] Uploading',items.length, 'item(s) to', endpoint);

  try {
    await upload(items, endpoint, config.nsSecret);
    console.log('[Bridge] Upload successful:', endpoint);
  } catch (err) {
    console.error('[Bridge] Upload failed:', endpoint);
    console.error(err);
  }
}

async function ensureLogin(): Promise<void> {
  if (!fs.existsSync(LOGINDATA_FILE)) {
    console.log('[Bridge] No logindata.json found — starting login flow...');
    const isUS = (process.env['MMCONNECT_SERVER'] || 'EU').toUpperCase() !== 'EU';
    await login(isUS, config.username, config.password);
    console.log('');
  }
}

async function requestLoop(client: CumulusClient): Promise<void> {
  while (true) {
    try {
      const result = await client.fetchRecent(config.patientId);
      console.log('[Bridge] Cumulus returned');

      const data = result.data;
      console.log(
        '[Bridge] Data received:',
        Object.keys(data || {}).length,
        'keys',
      );

      const transformed = transform(data, config.sgvLimit);

      console.log(
        '[Bridge] Transformed:',
        transformed.entries.length,
        'SGVs,',
        transformed.devicestatus.length,
        'device statuses',
      );

      const newSgvs = filterSgvs(transformed.entries);
      const newDeviceStatuses = filterDeviceStatus(transformed.devicestatus);

      console.log(
        '[Bridge] New:',
        newSgvs.length,
        'SGVs,',
        newDeviceStatuses.length,
        'device statuses',
      );

      logger.log(
        `Next check in ${Math.round(config.interval / 1000)}s` +
        ` (at ${new Date(Date.now() + config.interval)})`,
      );

      await uploadIfNew(newSgvs, entriesUrl);
      await uploadIfNew(newDeviceStatuses, devicestatusUrl);

    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'response' in error &&
        (error as { response?: { status?: number } }).response?.status === 401
      ) {
        console.error(
          '[Bridge] CareLink authentication expired (401).',
        );
      } else {
        console.error('[Bridge] Poll failed:', error);
      }
  } 

    await sleep(config.interval);
  }
}

// Start
try {
  await ensureLogin();

  const isUS =
    (process.env['MMCONNECT_SERVER'] || 'EU').toUpperCase() !== 'EU';

  const urls = await discoverBaseUrls(isUS);

  const loginData = JSON.parse(
    fs.readFileSync(LOGINDATA_FILE, 'utf8'),
  );

  const client = new CumulusClient(
    loginData,
    urls,
  );

  console.log(`[Bridge] Starting — interval set to ${config.interval / 1000}s`);
  console.log('[Bridge] Fetching data now...');
  await requestLoop(client);
} catch (err)
  {console.error(
    '[Bridge] Fatal:', (err as Error).message);
  process.exit(1);
}