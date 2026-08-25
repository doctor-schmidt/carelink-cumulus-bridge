# CareLink Cumulus Bridge

**Get glucose data from the Medtronic MiniMed Go / Instinct sensor into xDrip+, Nightscout, and smartwatches.**

If you have an **Instinct sensor** (made by Abbott, sold by Medtronic) and xDrip+'s
CareLink Follower returns **HTTP 204** with no data — this repo explains why and fixes it.

---

## The problem

The Instinct sensor and the MiniMed Go app do **not** use the legacy CareLink API that
existing tools target. They use a newer API that Medtronic's discovery config calls
**`baseUrlCumulus`**.

xDrip+ has not implemented it. From the
[xDrip discussion](https://github.com/NightscoutFoundation/xDrip/discussions/4318):

> *"The instinct sensor seem to use a new api called `Cumulus` so these sensors probably
> won't work until this is implemented."*

As of August 2026 that is still the case. Every existing bridge
([carelink-bridge](https://github.com/domien-f/carelink-bridge),
[minimed-connect-to-nightscout](https://github.com/nightscout/minimed-connect-to-nightscout))
targets the old endpoints, so Instinct users get nothing.

Additionally, the MiniMed Go app posts **no persistent notification containing the glucose
number** (its alarms only say "high"/"low"), so xDrip+'s Companion App mode has nothing to
scrape either. Juggluco cannot take over the sensor because it was not activated with
Abbott's own Libre 3 app — and running two apps against a Libre 3 in parallel breaks
both connections, which would compromise the official clinical alarms.

That leaves the cloud API as the only viable path.

## The finding

`POST {baseUrlCumulus}/display/message` enforces a **minimum client version**. Send an old
one and the server replies:

```
HTTP 206
{"message": "Upgrade application"}
```

xDrip+ was sending `appVersion: "3.6.0"`, which Medtronic no longer accepts.

Tested against a live MiniMed Go + Instinct account (EU, care partner), varying one field
at a time:

| `appVersion` | result |
| --- | --- |
| `3.5.0`, `3.6`, `3.6.1`, `3.6.9` | 206 `Upgrade application` |
| `3.7`, `3.7.0`, `3.8`, `3.8.0`, `4.0.0`, `10.0.0` | **200 OK** |

**Boundary: ≥ 3.7 accepted, ≤ 3.6.9 rejected.** Both `X.Y` and `X.Y.Z` forms work.

The working request:

```jsonc
POST https://clcloud.minimed.eu/connect/carepartner/v13/display/message
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "username":   "<care partner username>",
  "role":       "carepartner",
  "patientId":  "<patient username>",
  "appVersion": "3.8.0"     // <-- must be >= 3.7
}
```

`appVersion` is a **body field, not a header**. Twelve header variants were tested and all
failed: `User-Agent` spoofing (CareLinkConnect, okhttp, com.medtronic.carepartner) and the
headers `x-app-version`, `app-version`, `client-version`, `x-client-version` and
`x-carelink-app-version`.

> **`os: "android"` is optional.** An earlier version of this document claimed it was
> required — it is not. A control request with `appVersion: "3.8.0"` and no `os` field
> returns 200 with full data. The real app does send it, so this bridge includes it, but
> it is not what unblocks the request.

### The two version fields behave differently

| Where | Constraint |
| --- | --- |
| Discovery path `/discover/android/<ver>` | `3.5` → Cumulus **v11**; `3.6`–`3.8` → **v13**; **`3.9`+ falls back to a legacy config** (`/connect/carepartner/v2`, no Auth0) |
| Body `appVersion` | must be **≥ 3.7**, no upper bound |

So the discovery URL must stay at `3.8` while the body value can go higher. If Medtronic
raises the minimum again, only the body needs changing.

### Response format differences

1. Everything is nested under **`patientData`** (the old API had it at the root).
2. Readings use **`timestamp`**, not `datetime`, and carry **no timezone** — they are
   the patient's local time (`patientData.clientTimeZoneName`).
3. The **`sgs` array is not sorted** by time.

---

## Architecture

```
Instinct sensor (Abbott)
   │ BLE
   ▼
MiniMed Go app  ──uploads──▶  CareLink cloud
                                   │  this bridge polls /display/message
                                   ▼
                        Nightscout-compatible API
                                   │
                         xDrip+ (Nightscout Follower)
                                   │
                    WatchDrip+ ──▶ smartwatch
```

The bridge is **read-only against the cloud**. It never touches the sensor or the official
app, so **the official clinical alarms keep working untouched**.

### Measured latency

| Hop | Delay |
| --- | --- |
| Sensor → MiniMed Go → CareLink cloud | **~4.5 min** (not controllable) |
| Cloud → bridge | 0–`POLL_INTERVAL` |
| Bridge → xDrip+ | xDrip's follower interval |
| xDrip+ → watch | seconds |

Realistic end to end: **5–8 minutes**. The sensor itself produces a reading every minute.

---

## Setup

Requires a CareLink **care partner** account (a patient account returns HTTP 204),
approved by the patient in MiniMed Go → Profile → CareLink → Manage care partners.

```bash
npm install
npm run login    # opens a browser at Medtronic's real login page
npm run probe    # verifies the API returns your data
npm run serve    # starts the Nightscout-compatible server
```

`npm run login` writes `logindata.json` (access + refresh token). **Treat it as a
credential** — it grants access to the patient's health data. It is gitignored.

### Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `LOGINDATA_JSON` | in the cloud | Contents of `logindata.json`, one line. Seeds the token. |
| `API_SECRET` | recommended | Protects reads. **Without it the endpoint is public.** |
| `MMCONNECT_SERVER` | no | `EU` (default) or `US` |
| `POLL_INTERVAL` | no | Seconds between CareLink polls. Default `120`. Do not go below 60. |
| `CARELINK_PATIENT` | no | Only if the care partner follows several patients |
| `DATA_DIR` | no | Persistent dir for the refreshed token. Use a volume. |
| `PORT` | no | Injected by most hosts |

> **Persist `DATA_DIR` on a volume.** Refresh tokens rotate; without persistence a
> redeploy falls back to the seed token, which may already be invalid.

### ⚠️ Only one instance may refresh the token

Auth0 **rotates** refresh tokens, and reusing a spent one triggers reuse detection, which
**revokes the whole token family**.

In practice: if the bridge is deployed and you also run something locally that refreshes
using an older copy of `logindata.json`, you kill the deployment. That happened while
building this — 13 consecutive 403s and no data on the watch until a fresh login.

Two safeguards are built in:

- The diagnostic probes **never refresh**. If the local access token is expired they fail
  with instructions instead of touching anything.
- The server **self-heals**: if its stored refresh token is rejected and `LOGINDATA_JSON`
  now holds a different one, it adopts the seed and persists it. So after a fresh login you
  only need to update that variable — no need to clear the volume by hand.

### Endpoints

| Route | Purpose |
| --- | --- |
| `GET /health` | Diagnostics: cache age, reading count, last value, errors. No auth. |
| `GET /api/v1/status.json` | Nightscout status |
| `GET /api/v1/entries.json?count=N` | Readings, newest first. Alias `/api/v1/entries/sgv.json` |

Auth: `api-secret` header (SHA1 of the secret, Nightscout convention) or `?token=`.

### Deploying

See **[DEPLOY.md](DEPLOY.md)** (Railway) and **[SELFHOST.md](SELFHOST.md)**
(Docker / systemd / Tailscale). A `Dockerfile` and `docker-compose.yml` are included.

> The container runs as **root on purpose**: hosts commonly mount volumes owned by root,
> and dropping to an unprivileged user makes the token write fail with `EACCES`.

### Client setup

**xDrip+**: Hardware Data Source → **Nightscout Follower**, URL
`https://<API_SECRET>@your-host`, then Inter-app settings → **Broadcast Service API = ON**.

**WatchDrip+** (Xiaomi Smart Band 8 Pro / 9 / 10, Redmi Watch 4): `Enable service` ON,
`Enable Xiaomi service` ON, **`Enable device` OFF**. Watchfaces "Watchdrip+ Graph" and
"Watchdrip+ Big" live in the modded Mi Fitness app under Mods → **english** category.

---

## Credits

- [**domien-f/carelink-bridge**](https://github.com/domien-f/carelink-bridge) — this project
  is built on it. The Auth0/OAuth2 PKCE login, token refresh and Nightscout transform are
  its work. MIT licensed; the original `LICENSE` is preserved.
- [**ondrej1024/carelink-python-client**](https://github.com/ondrej1024/carelink-python-client)
  — documented the `/users/me` → `/links/patients` → `/display/message` flow, plus
  [@palmarci](https://github.com/palmarci) and [@m0rt4l1n](https://github.com/m0rt4l1n)
  for the login work.
- [**Artem Kovalenko**](https://bigdigital.home.blog/) — WatchDrip+, and
  [**Nimrod100**](https://github.com/miguelavh/Watchdrip-Xiaomi) for Xiaomi HyperOS support.

The `appVersion`/`os` requirement documented here was found by experimentation and, as far
as we can tell, was not published anywhere before. **PRs welcome** — especially to get this
into xDrip+ so the bridge becomes unnecessary.

## Disclaimer

**Not a medical device. Not certified. Secondary visualisation only.**

Keep your clinical alarms in the official app. Never dose insulin based on what this shows.
Data arrives minutes late by design. This is a community project with no warranty of any
kind — see [LICENSE](LICENSE).

---

## En español

Este proyecto resuelve el caso de los sensores **Instinct** de Medtronic (fabricados por
Abbott), que no funcionan con el CareLink Follower de xDrip+ porque usan una API distinta
llamada **Cumulus**.

**La clave**: `POST /display/message` rechaza versiones de cliente antiguas. xDrip+ mandaba
`appVersion: "3.6.0"` y el servidor exige **≥ 3.7**; si no, responde
`206 {"message":"Upgrade application"}`. Va en el **cuerpo**, no en cabeceras (probadas doce variantes). El campo `os` es opcional.

El bridge lee **solo de la nube**: no toca el sensor ni la app oficial, así que **las
alarmas clínicas siguen intactas**. Latencia real medida: 5–8 minutos.

Necesitas una cuenta de **care partner** (con la de paciente da HTTP 204), aprobada desde
MiniMed Go → Perfil → CareLink → Gestionar cuidadores.

**Visualización secundaria, no certificada. Nunca dosifiques insulina con esto.**
