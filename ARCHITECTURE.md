# Request — Architecture

## Verdict sur la stack proposée

La stack de départ (Vite avec Rolldown et deux entrées client, React SSR en streaming avec Suspense, Fastify, Platformatic Watt avec workers, Relay et GraphQL, XDS, TypeScript et Tailwind) est pensée pour une grosse application publique à fort trafic et à grosse équipe. Pour un portail privé, mono-serveur, de quelques dizaines d'utilisateurs, une partie est surdimensionnée.

| Élément                                     | Décision                     | Raison                                                                                                                                                              |
| ------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vite (Rolldown)                             | **Garder**                   | Build rapide, standard.                                                                                                                                             |
| React + TypeScript                          | **Garder**                   | Requis par shadcn, écosystème riche.                                                                                                                                |
| Tailwind                                    | **Garder** (v4)              | Base de shadcn.                                                                                                                                                     |
| XDS → **shadcn/ui**                         | **Garder, variante Base UI** | XDS reposait sur Base UI : shadcn propose ses composants sur Radix ou sur Base UI. Choisir Base UI à l'initialisation (à confirmer avec la CLI du moment).          |
| Fastify                                     | **Garder**                   | Léger, typé, sert l'API et le front compilé.                                                                                                                        |
| SSR en streaming + Suspense                 | **Retirer**                  | Tout est derrière une connexion, le référencement ne compte pas. Une SPA servie par Fastify est plus simple ; Suspense reste utile côté client avec TanStack Query. |
| Deux entrées client (connecté / déconnecté) | **Retirer**                  | Une seule SPA avec chargement différé par route suffit.                                                                                                             |
| Platformatic Watt (workers)                 | **Retirer**                  | Un seul processus Node tient largement la charge ; Watt ajoute une couche à configurer et à déboguer.                                                               |
| Relay + GraphQL                             | **Retirer**                  | Schéma, compilateur Relay et résolveurs pour une API d'une vingtaine de routes. Remplacé par une API REST typée de bout en bout.                                    |
| Type-check via tsrs                         | **Facultatif**               | `tsc --noEmit` suffit à cette taille ; à reprendre si le check devient lent.                                                                                        |

## Stack retenue

- **Node 26** (`.nvmrc`), TypeScript strict partout, ESM.
- **Front** : Vite, React 19, TanStack Router (routes typées, chargement différé) et TanStack Query (cache, Suspense, invalidation), shadcn/ui sur Base UI, Tailwind v4, icônes `lucide-react`, police Inter Variable (Fontsource, locale).
- **Serveur** : Fastify 5, validation et types partagés avec **Zod** (schémas dans `shared/`, réutilisés par le front), sessions par cookie `httpOnly` signé, protection CSRF par en-tête et contrôle d'origine.
- **Base** : **SQLite** (un fichier, `better-sqlite3`) via **Drizzle ORM** et ses migrations. Raison : un seul conteneur, une seule sauvegarde, zéro configuration, comme Seerr. Drizzle permet de passer à PostgreSQL plus tard si besoin.
- **Tâches planifiées** : dans le même processus (`croner`), avec verrou en base pour ne jamais lancer deux balayages en parallèle.
- **Secrets** (clés Radarr, Sonarr, Emby, TMDB) : stockés chiffrés en base avec une clé générée au premier lancement dans le dossier de données.
- **Qualité** : Biome (lint et format), Vitest (unitaires et routes Fastify avec `inject`), Playwright (parcours clés, axe pour l'accessibilité), MSW ou faux serveurs pour Emby, Radarr, Sonarr et TMDB.

## Organisation du dépôt

```
src/
  client/       SPA React : routes/, components/ (ui/ = shadcn), features/<domaine>/, styles/tokens.css
  server/       Fastify : routes/<domaine>.ts, services/<domaine>.ts, integrations/{emby,radarr,sonarr,tmdb,discord}.ts, jobs/, db/{schema.ts,migrations/}
  shared/       schémas Zod, types, constantes de statuts et de droits (une seule définition)
test/           vitest + fixtures des API externes
e2e/            Playwright
deploy/         Dockerfile, compose.yml, Caddyfile
```

## Modèle de données (première version)

- `users` (id Emby, nom, avatar, rôle, droits, quotas), `sessions`.
- `media` (tmdbId, type, statut global, ids Radarr/Sonarr/Emby, dates) et `seasons` (statut par saison).
- `requests` (média, saisons demandées, demandeur, statut : en attente, approuvée, refusée, disponible, échouée ; approbateur, motif, profil, dossier).
- `settings` (clé/valeur JSON validée par Zod, secrets chiffrés), `notifications`, `job_runs`.

Le statut d'un média est calculé côté serveur à partir de Radarr/Sonarr et d'Emby, puis mis en cache dans `media` ; le front ne le déduit jamais.

## Intégrations

- **TMDB** : découverte, recherche, fiches ; réponses en cache mémoire (LRU, quelques heures) pour rester sous les limites et rendre l'interface instantanée. Langue `fr-FR` avec repli `en-US`.
- **Emby** : authentification des membres (`/Users/AuthenticateByName`), liste des utilisateurs, éléments des bibliothèques (par ids TMDB/TVDB), lien « Regarder dans Emby ».
- **Radarr / Sonarr** (API v3) : profils, dossiers racine, ajout avec recherche, file de téléchargement, webhooks entrants « téléchargé » (URL avec jeton secret).
- **Discord** (facultatif, désactivé par défaut) : webhook sortant, branché sur les mêmes évènements que les notifications de l'appli ; sans webhook, aucun appel.

Chaque intégration est un module unique, typé, avec délai d'expiration, nouvelles tentatives limitées et messages d'erreur lisibles pour l'assistant (« Clé d'API refusée par Radarr », « Emby injoignable à cette adresse »).

## Déploiement

Comme Hub : image Docker `linux/amd64` (GHCR), `compose.yml` avec un seul service, conteneur `read_only`, `cap_drop: [ALL]`, `no-new-privileges`, volume `/data` (base SQLite, clé de chiffrement, cache d'images éventuel), healthcheck `/api/health`, derrière Caddy en HTTPS. Joint Radarr, Sonarr et Emby par le réseau Docker de l'hôte. Migration depuis Seerr : import facultatif des demandes existantes (lecture de sa base SQLite) en fin de MVP.
