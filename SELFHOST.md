# Alojar el bridge en un servidor propio

Guía para quien administre el servidor. El servicio lee la glucosa de la nube de
CareLink y la sirve en formato Nightscout para que xDrip+ la consuma.

**Consumo**: ~50 MB de RAM, CPU despreciable. Una consulta saliente cada 2 minutos.

---

## Requisitos

- Docker + Docker Compose (o Node 22+ si se prefiere sin contenedor)
- Salida a internet hacia `carelink.minimed.eu` y `clcloud.minimed.eu`
- Una forma de que el móvil llegue al servicio: **Tailscale** (recomendado) o
  un proxy inverso con HTTPS

---

## 1. Preparar los secretos

En la misma carpeta que `docker-compose.yml`, crea un fichero `.env`:

```bash
API_SECRET=una-cadena-larga-y-aleatoria
LOGINDATA_JSON={"access_token":"...","refresh_token":"...", ... }
```

- `API_SECRET`: invéntate una cadena larga. Protege la lectura de los datos.
  Genera una con: `openssl rand -hex 24`
- `LOGINDATA_JSON`: el contenido **completo** de `logindata.json` en **una sola línea**.
  Ese fichero lo genera el dueño de los datos en su PC con `npm run login`.

```bash
chmod 600 .env      # que no lo lea nadie más
```

> ⚠️ `LOGINDATA_JSON` da acceso a los datos de salud del paciente. Trátalo como una
> contraseña: nada de repositorios, nada de pegarlo en chats, nada de copias sueltas.

## 2. Arrancar

```bash
docker compose up -d --build
docker compose logs -f
```

Deberías ver:

```
[init] región: EU · intervalo: 120 s
[init] auth de lectura: API_SECRET activo
[poll] OK · 539 lecturas · última=112
[init] escuchando en :3000
```

Comprobación local:

```bash
curl -s http://127.0.0.1:3000/health
# {"ok":true,"lastFetchSecondsAgo":12,"readings":539,"lastSG":112,...}
```

---

## 3. Que el móvil llegue al servicio

### Opción A — Tailscale (recomendada)

No expone nada a internet. El móvil y el servidor se ven en una red privada.

```bash
# en el servidor
tailscale up
tailscale cert "$(tailscale status --json | jq -r .Self.DNSName | sed 's/\.$//')"
tailscale serve --bg --https=443 http://127.0.0.1:3000
```

En el móvil: instala Tailscale, inicia sesión con la misma cuenta.
La URL para xDrip+ será `https://<nombre-maquina>.<tailnet>.ts.net`.

Ventajas: sin puertos abiertos, sin certificados que renovar a mano, cifrado extremo
a extremo, y sólo los dispositivos de esa cuenta pueden acceder.

### Opción B — Proxy inverso público (Caddy)

Si ya hay un dominio apuntando al servidor. Caddy saca el certificado solo.

```caddyfile
glucosa.tudominio.com {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy
```

> **HTTPS no es opcional.** xDrip+ manda el `API_SECRET` en cada petición; en HTTP plano
> viajaría legible. Android además bloquea el tráfico en claro por defecto.

---

## 4. Verificar de extremo a extremo

```bash
curl -s "https://TU-URL/health"
curl -s "https://TU-URL/api/v1/entries.json?count=3&token=EL_API_SECRET"
```

La segunda debe devolver tres lecturas con `sgv`, `date` y `direction`.

---

## 5. Mantenimiento

```bash
docker compose logs --tail=50        # ver estado
docker compose restart               # reiniciar
docker compose up -d --build         # actualizar tras cambiar el código
```

**Qué vigilar**: si `/health` devuelve `ok: false` con `consecutiveErrors` subiendo,
lo normal es que el refresh token haya caducado. Entonces el dueño de los datos repite
`npm run login` en su PC y se actualiza `LOGINDATA_JSON`.

El volumen `glucosa-data` guarda el token renovado, así que los reinicios y las
actualizaciones no obligan a volver a hacer login.

---

## Sin Docker (systemd)

```ini
# /etc/systemd/system/glucosa-bridge.service
[Unit]
Description=Bridge CareLink Cumulus -> Nightscout
After=network-online.target

[Service]
Type=simple
User=glucosa
WorkingDirectory=/opt/glucosa-bridge
EnvironmentFile=/opt/glucosa-bridge/.env
Environment=DATA_DIR=/var/lib/glucosa-bridge
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/glucosa-bridge

[Install]
WantedBy=multi-user.target
```

```bash
npm ci && npm run build
sudo systemctl enable --now glucosa-bridge
```

---

## Alcance clínico

Visualización secundaria, **no certificada**. Las alarmas clínicas siguen en la app
oficial del paciente. Este servicio sólo **lee** de la nube: no toca el sensor ni la
app oficial, y no puede alterar ningún tratamiento.
