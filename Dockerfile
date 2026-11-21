# syntax=docker/dockerfile:1
# Image linux/amd64 : une étape de build (client Vite), une étape de dépendances de production (better-sqlite3 est
# compilé ici, avec les outils de build) et une image finale sans outils, qui tourne sans privilèges.
ARG NODE_VERSION=26
ARG BUN_VERSION=1.4.5

FROM oven/bun:${BUN_VERSION} AS bun

FROM node:${NODE_VERSION}-slim AS tools
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
# Bun installe les dépendances (bun.lock) ; Node reste le runtime de l'appli et de Vite. Le cache de paquets de Bun est
# un cache BuildKit (copié, pas lié, dans node_modules) : un bun.lock modifié ne retélécharge que ce qui a changé.
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

# Dépendances de production seules, binaire natif compilé puis vérifié (un binaire absent échoue ici, pas au démarrage).
FROM tools AS prod-deps
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile --production --ignore-scripts --backend=copyfile \
  && npm rebuild better-sqlite3 --foreground-scripts \
  && node -e "new (require('better-sqlite3'))(':memory:')"

# Client : toutes les dépendances, `vite build` écrit dist/client.
FROM tools AS build
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile --ignore-scripts --backend=copyfile
COPY . .
RUN bun run build

FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app
# /data appartient à l'utilisateur `node` : un volume nommé vide en hérite au premier montage.
RUN mkdir /data && chown node:node /data
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/server ./src/server
COPY src/shared ./src/shared
COPY scripts ./scripts
COPY --from=build /app/dist/client ./dist/client
# Commit de l'image, montré dans Réglages › À propos (placé ici : un commit neuf ne relance pas les étapes d'avant).
ARG GIT_SHA=""
ENV GIT_SHA=${GIT_SHA}
USER node
VOLUME /data
EXPOSE 3000
# Pas de curl dans l'image slim : Node suffit.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# `node` direct (pas `npm start`) : npm écrit dans ~/.npm (système de fichiers en lecture seule) et masque les signaux.
CMD ["node", "src/server/index.ts"]
