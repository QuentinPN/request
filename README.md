# Request

Portail de demandes de films et de séries pour les membres d'un serveur multimédia (Emby, Jellyfin ou Plex) : on
cherche, on demande, l'administrateur approuve, Radarr ou Sonarr télécharge, et le membre est prévenu quand le titre
est disponible. Les membres se connectent avec leur compte du serveur multimédia. Détails dans `PRODUCT.md`.

## Pile

- Bun 1.4.5 (runtime, tests, SQLite intégré via `bun:sqlite`), Fastify 5, Drizzle ORM.
- Client React 19, TanStack Router et Query, Tailwind CSS 4, construit par Vite.
- Docker (`linux/amd64`) derrière Caddy pour le HTTPS. Données dans le volume `/data`.

## Lancer avec Docker

Prérequis : Docker avec Compose v2, un domaine qui pointe vers l'hôte, ports 80 et 443 joignables.

```sh
cp .env.example .env        # renseigner DOMAIN
docker compose up -d --build
docker compose ps           # le service doit passer « healthy »
```

Au premier lancement, l'assistant de configuration demande le jeton d'installation écrit dans les journaux
(`docker compose logs`). Variables, réseau local seul, sauvegardes et mises à jour : `docs/DEPLOIEMENT.md`.

## Développer

```sh
bun install
bun run dev                 # serveur de développement Vite
bun run verify              # lint, format, types, tests, build
```

## Tests

```sh
bun run test                # bun test, isolés, en parallèle et dans un ordre aléatoire
```

Les tests sont dans `test/` ; les hooks git qui les lancent avant un push sont décrits dans `CONTRIBUTING.md`.

## Licence

MIT, voir `LICENSE`.
