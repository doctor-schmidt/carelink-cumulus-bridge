# Levantar el bridge en un servidor ajeno

Todo lo que hace falta son **tres ficheros** y un comando. No hay que clonar el repo
ni compilar nada: la imagen ya está publicada.

## 1. Ficheros

```
docker-compose.yml     (este directorio)
.env                   (copiar de .env.example y rellenar)
```

## 2. Las dos variables que hay que rellenar

| Variable | De dónde sale |
|---|---|
| `LOGINDATA_JSON` | Contenido completo de `logindata.json`, en una línea. Lo genera el paciente con `npm run login` en su PC. |
| `API_SECRET` | Cualquier cadena larga. `openssl rand -hex 24` |

```bash
cp .env.example .env
nano .env
chmod 600 .env
```

## 3. Arrancar

```bash
docker compose up -d
docker compose logs -f
```

Esperado:

```
[init] región: EU · intervalo: 60 s
[init] auth de lectura: API_SECRET activo
[poll] OK · 296 lecturas · última=114
[init] escuchando en :3000
```

## 4. Comprobar

```bash
curl -s http://127.0.0.1:3000/health
```

`{"ok":true,"stale":false,...}` → funcionando.
Devuelve **503** si los datos superan `STALE_AFTER` (15 min), así que sirve
directamente para un monitor de uptime.

## 5. Exponerlo al móvil

El contenedor sólo escucha en `127.0.0.1`. Hay que ponerle delante:

- **Tailscale** (recomendado): sin abrir puertos, sin certificados.
- **Caddy / nginx** con HTTPS si hay dominio.

HTTPS **no es opcional**: xDrip+ manda el `API_SECRET` en cada petición.
Detalles en [`../SELFHOST.md`](../SELFHOST.md).

## 6. Mantenimiento

```bash
docker compose pull && docker compose up -d   # actualizar
docker compose logs --tail=50                 # ver estado
```

Si `/health` da `ok:false` con `consecutiveErrors` subiendo, lo normal es que el
refresh token haya caducado: el paciente repite `npm run login` y se actualiza
`LOGINDATA_JSON`. El servidor adopta la semilla nueva solo (una vez).

---

## ⚠️ Antes de dárselo a alguien

Quien administre ese servidor puede leer `LOGINDATA_JSON` y, con él, **los datos de
salud del paciente**. Alójalo sólo con alguien de confianza para eso.

El servicio es **solo lectura** contra la nube: no toca el sensor ni la app oficial,
y no puede alterar ningún tratamiento. **Visualización secundaria, no certificada.**
