# Guide développeur

Request est un portail de demandes de films et de séries pour les membres d'un serveur multimédia (Emby, Jellyfin ou
Plex) : on cherche, on demande, l'administrateur approuve, Radarr ou Sonarr télécharge, et le membre est prévenu quand
le titre est disponible. Les membres se connectent avec leur compte du serveur multimédia. Détails dans
[`PRODUCT.md`](../PRODUCT.md).

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
(`docker compose logs`). Variables, réseau local seul, sauvegardes et mises à jour : [`DEPLOIEMENT.md`](DEPLOIEMENT.md).

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

Les tests sont dans `test/` ; les hooks git qui les lancent avant un push sont décrits dans
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Pour aller plus loin

| Document                                 | Contenu                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| [`PRODUCT.md`](../PRODUCT.md)            | Fonctions et principes du produit                                        |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md)  | Choix techniques et organisation du dépôt                                |
| [`DESIGN.md`](../DESIGN.md)              | Direction visuelle                                                       |
| [`DECISIONS.md`](../DECISIONS.md)        | Décisions prises et leurs raisons                                        |
| [`ROADMAP.md`](../ROADMAP.md)            | Phases de travail                                                        |
| [`CHANGELOG.md`](../CHANGELOG.md)        | Historique des versions                                                  |
| [`API.md`](API.md)                       | API publique (clé `X-Api-Key`) ; description OpenAPI dans `openapi.json` |
| [`DATA_MODEL.md`](DATA_MODEL.md)         | Modèle de données                                                        |
| [`STATE_MACHINES.md`](STATE_MACHINES.md) | Machines à états (demandes, statuts)                                     |
| [`integrations.md`](integrations.md)     | Référence vérifiée d'Emby, Jellyfin, Plex, Radarr, Sonarr et TMDB        |
| [`DEPLOIEMENT.md`](DEPLOIEMENT.md)       | Installation, sauvegardes, mises à jour, dépannage                       |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md)  | Hooks git et contrôles avant push                                        |

## Licence

MIT, voir [`LICENSE`](../LICENSE).
