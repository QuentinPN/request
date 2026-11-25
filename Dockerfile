# syntax=docker/dockerfile:1
# Image linux/amd64 sur Bun (runtime de l'appli, SQLite intégré via bun:sqlite : aucun module natif à compiler) : une
# étape de build (client Vite), une étape de dépendances de production et une image finale qui tourne sans privilèges.
ARG BUN_VERSION=1.4.5

FROM oven/bun:${BUN_VERSION} AS base
WORKDIR /app

# Le cache de paquets de Bun est un cache BuildKit (copié, pas lié, dans node_modules) : un bun.lock modifié ne
# retélécharge que ce qui a changé.
FROM base AS prod-deps
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile --production --ignore-scripts --backend=copyfile

# Client : toutes les dépendances, `vite build` (sous Bun) écrit dist/client.
FROM base AS build
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile --ignore-scripts --backend=copyfile
COPY . .
RUN bun run build

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
# /data appartient à l'utilisateur `bun` (uid 1000, comme `node` dans l'image Node d'avant) : un volume nommé vide en
# hérite au premier montage, un volume existant reste lisible.
RUN mkdir /data && chown bun:bun /data
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/server ./src/server
COPY src/shared ./src/shared
COPY scripts ./scripts
COPY --from=build /app/dist/client ./dist/client
# Commit de l'image, montré dans Réglages › À propos (placé ici : un commit neuf ne relance pas les étapes d'avant).
ARG GIT_SHA=""
ENV GIT_SHA=${GIT_SHA}
USER bun
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# `bun` direct (pas `bun run start`) : un seul processus, qui reçoit SIGTERM et ferme l'appli proprement.
CMD ["bun", "src/server/index.ts"]
