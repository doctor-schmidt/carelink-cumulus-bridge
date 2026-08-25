# Bridge CareLink Cumulus -> Nightscout
# Imagen pequeña, sin privilegios, con healthcheck.
FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# --- imagen final ---------------------------------------------------------
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# El token renovado se persiste aquí: monta un volumen en /data.
ENV DATA_DIR=/data
RUN mkdir -p /data

# Se ejecuta como root A PROPÓSITO: Railway monta el volumen perteneciendo a root,
# y con USER node la escritura de /data/logindata.json falla con EACCES.
# Sin esa escritura no se persiste el refresh token y el servicio se rompería
# en el siguiente redespliegue. El contenedor no expone nada más que el puerto HTTP.
EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
