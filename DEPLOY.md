# Despliegue del bridge CareLink Cumulus → Nightscout

Servidor que lee la glucosa del sensor **MiniMed Instinct** (vía la API Cumulus de
CareLink) y la sirve en formato **Nightscout**, para que xDrip+ la consuma como
*Nightscout Follower*.

```
Instinct → MiniMed Go → nube CareLink → [este bridge] → xDrip+ → WatchDrip+ → Band 8 Pro
```

---

## 1. Requisitos

- Una cuenta **care partner** de CareLink, aprobada por el paciente en MiniMed Go
  (Perfil → CareLink → Gestionar cuidadores → Aprobar).
- Node 18+ en local, sólo para el login inicial.

## 2. Login (en local, una sola vez)

```bash
npm install
npm run login      # abre el navegador con la página real de Medtronic
npm run probe      # comprueba que llegan datos
```

Esto genera **`logindata.json`** con el `access_token` y el `refresh_token`.
Ese fichero es un **secreto**: da acceso a los datos de salud del paciente.
Está en `.gitignore`. No lo subas a ningún repositorio ni lo pegues en un chat.

## 3. Variables de entorno del servidor

| Variable | Obligatoria | Descripción |
|---|---|---|
| `LOGINDATA_JSON` | sí (en la nube) | El **contenido completo** de `logindata.json`, en una línea. Semilla del token. |
| `API_SECRET` | recomendada | Protege la lectura. Si se omite, **el endpoint queda abierto a internet**. |
| `MMCONNECT_SERVER` | no | `EU` (por defecto) o `US`. |
| `POLL_INTERVAL` | no | Segundos entre consultas a CareLink. Por defecto `120`. |
| `CARELINK_PATIENT` | no | Sólo si la cuenta de cuidador sigue a varios pacientes. |
| `DATA_DIR` | no | Carpeta persistente para el token renovado. Ver aviso abajo. |
| `PORT` | no | Lo inyecta Railway automáticamente. |

### ⚠️ Persistencia del refresh token

El disco de Railway es efímero: se borra en cada despliegue. El bridge escribe el token
renovado en `DATA_DIR/logindata.json`.

- **Sin volumen**: al redesplegar se vuelve a la semilla de `LOGINDATA_JSON`. Si ese
  refresh token ya caducó o rotó, hay que repetir el `npm run login` en local y
  actualizar la variable.
- **Con volumen** (recomendado): monta un volumen y pon `DATA_DIR` a su ruta
  (p. ej. `/data`). Así el token sobrevive a los despliegues.

## 4. Desplegar en Railway

```bash
railway login          # elige TÚ la cuenta en el navegador
railway init           # crea el proyecto
railway up             # despliega
railway domain         # genera la URL pública
```

Después, en el panel de Railway → Variables, añade `LOGINDATA_JSON` y `API_SECRET`.
**Pégalos tú directamente en el panel**, no los pases por chat.

`railway.json` ya fija el build (`npm ci && npm run build`), el arranque
(`node dist/server.js`) y el healthcheck (`/health`).

## 5. Comprobar

```bash
curl https://TU-APP.up.railway.app/health
curl "https://TU-APP.up.railway.app/api/v1/entries.json?count=3&token=TU_API_SECRET"
```

`/health` debe devolver `ok: true` con un número de lecturas y el último valor.

## 6. Configurar xDrip+

1. Ajustes → **Hardware Data Source** → **Nightscout Follower**
2. URL: `https://TU_API_SECRET@TU-APP.up.railway.app`
   (el secreto va delante de la @, es como xDrip+ espera el token de Nightscout)
3. Ajustes → **Inter-app settings** → **Broadcast Service API = ON**
4. Unidades: **mg/dL**

Luego WatchDrip+: `Enable service` ON, `Enable Xiaomi service` ON, **`Enable device` OFF**.

---

## Endpoints

| Ruta | Qué hace |
|---|---|
| `GET /health` | Diagnóstico: última consulta, nº de lecturas, último valor, errores. Sin auth. |
| `GET /api/v1/status.json` | Estado en formato Nightscout. xDrip+ lo consulta al conectar. |
| `GET /api/v1/entries.json?count=N` | Lecturas, de más nueva a más vieja. Alias: `/api/v1/entries/sgv.json`. |

Autenticación: cabecera `api-secret` (SHA1 del secreto, como Nightscout) o `?token=`.

---

## Notas técnicas

- `POST {baseUrlCumulus}/display/message` exige **`appVersion` y `os` en el body**.
  Sin ellos: `HTTP 206 {"message":"Upgrade application"}`. No sirve mandarlos como cabecera.
- Versiones reconocidas por el discovery: 3.6–3.8 → Cumulus **v13**. 3.9+ cae a una
  config antigua. El bridge declara **3.8**.
- Los datos vienen anidados en `patientData`; las lecturas usan `timestamp` (no
  `datetime`) y **sin zona horaria**: son hora local del paciente. El bridge deduce el
  desfase comparando `lastConduitDateTime` con `currentServerTime`.
- El array `sgs` **no viene ordenado** por tiempo.

## Alcance clínico

Visualización secundaria, no certificada. **Las alarmas clínicas siguen en MiniMed Go.**
Este bridge sólo lee de la nube: no toca el sensor ni la app oficial.
