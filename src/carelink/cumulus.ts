/**
 * Cliente para la API "Cumulus" de CareLink.
 *
 * Es la API que usa la app CareLink Connect (care partner) y la que necesitan
 * los sensores nuevos (Instinct / MiniMed Go). xDrip+ NO la implementa todavía,
 * que es justo por lo que su CareLink Follower devuelve HTTP 204 con Instinct.
 *
 * Flujo (según ondrej1024/carelink-python-client, carelink_client2.py):
 *   1) GET  {baseUrlCareLink}/users/me         -> rol y username
 *   2) GET  {baseUrlCareLink}/links/patients   -> paciente vinculado (si care partner)
 *   3) POST {baseUrlCumulus}/display/message   -> datos de glucosa
 *          body: { username, role, patientId }
 */
import axios, { type AxiosInstance } from 'axios';
import type {
  CareLinkData,
  CareLinkUserInfo,
  CareLinkPatientLink,
  DiscoverResponse,
  LoginData,
} from '../types/carelink.js';

/** User-Agent de la app Android; la API lo espera. */
const ANDROID_UA =
  'Dalvik/2.1.0 (Linux; U; Android 10; Nexus 5X Build/QQ3A.200805.001)';

/**
 * Versión de app que declaramos. El servidor sólo reconoce 3.6–3.8 (→ Cumulus v13);
 * 3.5 cae a v11 y 3.9+ a un config antiguo v2. Usamos la más alta reconocida.
 */
const APP_VERSION = '3.8';

const DISCOVERY_EU =
  `https://clcloud.minimed.eu/connect/carepartner/v13/discover/android/${APP_VERSION}`;
const DISCOVERY_US =
  `https://clcloud.minimed.com/connect/carepartner/v13/discover/android/${APP_VERSION}`;

export interface CumulusBaseUrls {
  baseUrlCareLink: string;
  baseUrlCumulus: string;
}

/** Envoltorio de la respuesta nueva: los datos van dentro de `patientData`. */
export interface CumulusResponse {
  metadata?: { kind?: string; version?: number; clientDateTime?: string };
  patientData?: Record<string, unknown>;
}

/**
 * Las lecturas usan `timestamp` (formato nuevo) y no `datetime` (formato viejo).
 * Sin zona horaria: son hora local del paciente.
 */
function tsOf(sg: { timestamp?: string; datetime?: string }): number {
  const raw = sg.timestamp || sg.datetime;
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/** Lee el discovery público y saca las base URLs de la región. No necesita auth. */
export async function discoverBaseUrls(isUS: boolean): Promise<CumulusBaseUrls> {
  const url = isUS ? DISCOVERY_US : DISCOVERY_EU;
  const resp = await axios.get<DiscoverResponse>(url, {
    headers: { 'User-Agent': ANDROID_UA, Accept: 'application/json' },
    timeout: 20_000,
  });

  const region = isUS ? 'us' : 'eu';
  const entry = resp.data.CP?.find(c => c.region?.toLowerCase() === region) as
    | Record<string, unknown>
    | undefined;

  if (!entry) throw new Error(`Discovery sin entrada para la región ${region}`);

  const baseUrlCareLink = entry['baseUrlCareLink'] as string | undefined;
  const baseUrlCumulus = entry['baseUrlCumulus'] as string | undefined;

  if (!baseUrlCareLink || !baseUrlCumulus) {
    throw new Error('Discovery sin baseUrlCareLink/baseUrlCumulus');
  }
  return { baseUrlCareLink, baseUrlCumulus };
}

export interface CumulusFetchResult {
  data: CareLinkData;
  role: string;
  patientId: string | undefined;
  /** Endpoint que acabó devolviendo los datos, para diagnóstico. */
  endpoint: string;
}

export class CumulusClient {
  private http: AxiosInstance;

  constructor(
    private loginData: LoginData & { 'mag-identifier'?: string },
    private urls: CumulusBaseUrls,
  ) {
    this.http = axios.create({ timeout: 20_000 });
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': ANDROID_UA,
      Authorization: 'Bearer ' + this.loginData.access_token,
    };
    // Sólo lo manda el flujo de login antiguo (MAG). El OAuth2 nuevo no lo trae.
    const mag = this.loginData['mag-identifier'];
    if (mag) h['mag-identifier'] = mag;
    return h;
  }

  /** Paso 1: quién soy y con qué rol. */
  async getUser(): Promise<CareLinkUserInfo> {
    const url = `${this.urls.baseUrlCareLink}/users/me`;
    const resp = await this.http.get<CareLinkUserInfo>(url, { headers: this.headers() });
    return resp.data;
  }

  /** Paso 2: pacientes vinculados a esta cuenta de care partner. */
  async getLinkedPatients(): Promise<CareLinkPatientLink[]> {
    const url = `${this.urls.baseUrlCareLink}/links/patients`;
    const resp = await this.http.get<CareLinkPatientLink[]>(url, { headers: this.headers() });
    return Array.isArray(resp.data) ? resp.data : [];
  }

  /**
   * Paso 3: los datos. Es el endpoint que le falta a xDrip+.
   *
   * ⚠️ CLAVE DEL ASUNTO (descubierto por experimentación, 25-08-2026):
   * sin `appVersion` y `os` en el BODY, el servidor responde
   * HTTP 206 {"message":"Upgrade application"} y no devuelve nada.
   * No son cabeceras: van en el cuerpo de la petición. Probadas y descartadas
   * todas las variantes de User-Agent y de cabeceras x-app-version/client-version.
   */
  async getDisplayMessage(
    username: string,
    role: string,
    patientId?: string,
  ): Promise<CareLinkData> {
    const url = `${this.urls.baseUrlCumulus}/display/message`;
    const body: Record<string, string> = {
      username,
      role,
      appVersion: APP_VERSION,
      os: 'android',
    };
    if (patientId) body.patientId = patientId;

    const resp = await this.http.post<CumulusResponse>(url, body, { headers: this.headers() });

    // 204 = autenticado pero sin contenido: el síntoma clásico de rol/cuenta equivocados.
    if (resp.status === 204 || !resp.data) {
      throw new Error(
        'HTTP 204 sin contenido en /display/message. ' +
          'Suele significar rol incorrecto (¿estás usando la cuenta de paciente ' +
          'en vez de la de care partner?) o patientId equivocado.',
      );
    }

    // 206 + {"message": "..."} es la respuesta de rechazo del servidor.
    const asMsg = resp.data as unknown as { message?: string };
    if (asMsg.message && !resp.data.patientData) {
      throw new Error(`El servidor rechazó la petición: "${asMsg.message}"`);
    }

    // La respuesta nueva anida todo en patientData; ahí están sgs, lastSG, bgUnits…
    const data = (resp.data.patientData ?? resp.data) as unknown as CareLinkData;

    // El array sgs NO viene ordenado por tiempo: hay que ordenarlo.
    if (Array.isArray(data.sgs)) {
      data.sgs = [...data.sgs].sort(
        (a, b) => tsOf(a) - tsOf(b),
      );
    }
    return data;
  }

  /** Orquesta los tres pasos y devuelve los datos más el contexto de diagnóstico. */
  async fetchRecent(explicitPatientId?: string): Promise<CumulusFetchResult> {
    const user = await this.getUser();
    const role = (user.role || '').toUpperCase();
    const username = user.username || '';

    if (!username) throw new Error('/users/me no devolvió username');

    const isCarePartner = role.includes('CARE_PARTNER') || role.includes('CAREPARTNER');

    let patientId = explicitPatientId;
    if (isCarePartner && !patientId) {
      const patients = await this.getLinkedPatients();
      if (patients.length === 0) {
        throw new Error(
          'La cuenta de care partner no tiene pacientes vinculados. ' +
            '¿Se aprobó la solicitud en MiniMed Go (Perfil → CareLink → Gestionar cuidadores)?',
        );
      }
      patientId = patients[0].username;
    }

    // La API espera el rol en minúsculas: "carepartner" o "patient".
    const apiRole = isCarePartner ? 'carepartner' : 'patient';
    const data = await this.getDisplayMessage(username, apiRole, patientId);

    return {
      data,
      role,
      patientId,
      endpoint: `${this.urls.baseUrlCumulus}/display/message`,
    };
  }
}
