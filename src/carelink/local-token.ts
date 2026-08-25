/**
 * Carga del token para HERRAMIENTAS LOCALES (sondas de diagnóstico).
 *
 * ⚠️ A propósito NO refresca el token.
 *
 * Auth0 **rota** los refresh tokens: cada refresco invalida el anterior. Si
 * detecta que se reutiliza uno ya gastado, asume robo de credenciales y
 * **revoca toda la familia de tokens**.
 *
 * Consecuencia práctica: si tienes el bridge desplegado y además refrescas
 * desde tu portátil con una copia vieja de logindata.json, tumbas el
 * despliegue. Le pasó a este proyecto: 13 fallos seguidos de 403 y el reloj
 * sin datos hasta rehacer el login.
 *
 * Regla: **sólo una instancia debe refrescar**. La desplegada.
 * Las sondas locales leen y, si el token está caducado, fallan con
 * instrucciones en vez de tocar nada.
 */
import fs from 'node:fs';
import { isTokenExpired } from './token.js';
import type { LoginData } from '../types/carelink.js';

export function loadLoginForProbe(loginPath: string): LoginData {
  if (!fs.existsSync(loginPath)) {
    throw new Error(
      'No hay logindata.json. Ejecuta primero:  npm run login',
    );
  }

  const data = JSON.parse(fs.readFileSync(loginPath, 'utf8')) as LoginData;

  if (isTokenExpired(data.access_token)) {
    throw new Error(
      'El access_token local está caducado.\n\n' +
      '  Las sondas NO lo refrescan a propósito: refrescar con un token ya\n' +
      '  rotado hace que Auth0 revoque toda la familia y tumbaría tu bridge\n' +
      '  desplegado (403 en bucle, reloj sin datos).\n\n' +
      '  Si el bridge está desplegado y funcionando, déjalo en paz.\n' +
      '  Si necesitas ejecutar la sonda:\n' +
      '    1) rm logindata.json && npm run login\n' +
      '    2) sube el nuevo logindata.json a la variable LOGINDATA_JSON del despliegue\n',
    );
  }

  return data;
}
