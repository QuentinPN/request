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
- **Tâches planifiées** : dans le même processus (`setInterval`, sans dépendance, `services/sync.ts`), avec verrou en base (`job_runs`) pour ne jamais lancer deux balayages en parallèle ; arrêtées à la fermeture de l'appli, désactivées dans les tests.
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
scripts/        outils d'exploitation (backup.ts)
Dockerfile, compose.yml, Caddyfile, .env.example, .dockerignore   (à la racine : le contexte de build est le dépôt)
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
- **Courriel** (facultatif) : SMTP via `nodemailer` (`services/email.ts`), réglage `smtp` du propriétaire (Réglages › Notifications par courriel : hôte, port, sécurité `none`/`starttls`/`tls`, identifiant, mot de passe chiffré jamais renvoyé, expéditeur, « Envoyer un essai » à l'adresse du propriétaire). `starttls` exige le chiffrement (`requireTLS`) ; délais de 15 s par étape, 30 s en tout pour l'essai ; le mot de passe enregistré ne sert que vers le même hôte, port, sécurité et identifiant. Gabarit sobre (texte + HTML échappé), lien vers l'appli si `PUBLIC_URL` est connue.
- **Push web** : `web-push` (`services/push.ts`), clés VAPID créées au premier besoin dans le réglage `vapid` (privée chiffrée), passées à chaque envoi (pas d'état global). Endpoints limités aux services push des navigateurs (`PUSH_SERVICE_DOMAINS` : FCM, Mozilla, WNS, Apple ; jamais une adresse interne, un abonnement hors liste est supprimé sans envoi) et plafonnés en longueur. Abonnements par appareil (`push_subscriptions`, `endpoint` unique : un appareil réabonné change de membre ; Compte ne le dit « activé » que si `POST /api/push/subscription/check` confirme qu'il est au membre connecté ; la déconnexion le désabonne, serveur et navigateur, s'il est au membre), supprimés sur réponse 404/410. Charge utile `{ title, body, url }`. Routes : `GET /api/push/public-key`, `PUT`/`DELETE /api/push/subscription`, `POST /api/push/subscription/check`, `POST /api/push/test`.

**Distribution des notifications** : `notify()` (`services/notifications.ts`) est le seul point d'entrée ; il écrit une ligne par destinataire dans la transaction de l'évènement (l'acteur exclu), puis prévient ses abonnés. `services/delivery.ts` relit ces lignes après la validation (id, destinataire, type et date : une transaction annulée n'envoie rien) et les rend avec le même rendu que la cloche, puis envoie par courriel (adresse renseignée, `email_notifications`, SMTP actif) et en push (`push_notifications`, au moins un appareil) ; personne à joindre hors de l'appli : ni rendu, ni TMDB. Discord reste branché sur les évènements de demande (`onRequestEvent`, un message par évènement). Tous ces envois passent par `AfterCommit` (`services/after-commit.ts`) : après la transaction (`setImmediate`), sans nouvelle tentative, sans jamais faire échouer la requête, chaque envoi indépendant des autres, erreurs journalisées sans adresse (code SMTP ou statut HTTP). Un nouveau type de notification (`notificationKinds`) écrit par `notify()` part donc aussi par courriel et en push sans autre code ; sa destination (file d'approbation ou fiche) vient de `notificationTarget` (`src/shared/notifications.ts`), commune à la cloche, au courriel et au push.

**Appli installable (PWA)** : `public/manifest.webmanifest` (nom, couleurs `--bg`, icônes 192/512 et `icon-maskable-512.png` à fond plein) et `public/sw.js`, servi à la racine (portée `/`, pas besoin de `Service-Worker-Allowed`) avec `Cache-Control: no-cache`. Le service worker ne met en cache que `hors-ligne.html` (et son icône) : seules les navigations passent par lui (réseau d'abord, page hors ligne sinon) ; aucune réponse de `/api`, ni de l'appli, n'est mise en cache. Il affiche les push (`showNotification`) et, au clic, met l'onglet de l'appli au premier plan sur l'adresse visée ou en ouvre un. Enregistré par le client en production seulement ; les e2e le bloquent (`serviceWorkers: 'block'`) et simulent le push du navigateur. Pas de CSP globale (seul le relais d'images en pose une), rien à y ajouter. Le push exige HTTPS (Caddy) ; sur iPhone/iPad, l'appli doit être ajoutée à l'écran d'accueil.

Chaque intégration est un module unique, typé, avec délai d'expiration, nouvelles tentatives limitées et messages d'erreur lisibles pour l'assistant (« Clé d'API refusée par Radarr », « Emby injoignable à cette adresse »).

## Déploiement

Procédure complète : [docs/DEPLOIEMENT.md](docs/DEPLOIEMENT.md).

- **Image** : `Dockerfile` multi-étapes, `linux/amd64`, `node:26-slim` (glibc). Le binaire natif de better-sqlite3 est compilé dans une étape à part avec les outils de build, puis vérifié ; l'image finale n'a que les dépendances de production, `src/server`, `src/shared`, `scripts/` et `dist/client`. Elle tourne en utilisateur `node` (uid 1000) avec `node src/server/index.ts` (SIGTERM/SIGINT ferment l'appli proprement : balayage fini, base fermée). Construite en CI (build seul, sans publication).
- **`compose.yml`** : le service `request` (`read_only`, tmpfs `/tmp`, `cap_drop: [ALL]`, `no-new-privileges`, `restart: unless-stopped`, volume nommé `/data`, `expose` sans port publié) et `caddy` (HTTPS automatique pour `DOMAIN`, ports 80/443, `Caddyfile` à la racine). Healthcheck de l'image : `GET /api/health` (public, hors garde de session), qui exécute aussi une requête triviale sur la base (503 sinon).
- **Volume `/data`** : `request.db` (SQLite WAL), `secret.key` (clé de chiffrement des secrets, créée au premier lancement, indispensable pour lire une sauvegarde), `cache/images/` et `backups/`.
- **Variables** : `PORT` (3000), `DATA_DIR` (`/data`), `HOST`, `TRUST_PROXY`, `IMAGE_CACHE_MAX_MB` (500), `BACKUP_KEEP` (7, 0 = pas de sauvegarde planifiée), `PUBLIC_URL` (adresse publique de l'appli : lien des courriels, contact VAPID ; `compose.yml` la fixe à `https://${DOMAIN}`).
- **Sauvegarde** : API de sauvegarde en ligne de SQLite (`services/backup.ts`) vers `/data/backups/request-AAAAMMJJ-HHMMSS.db`, planifiée une fois par jour dans le processus (comme les balayages, jamais dans les tests) et à la demande par `scripts/backup.ts` (`npm run backup`). Seules les `BACKUP_KEEP` plus récentes sont gardées.
- **Cache d'images borné** : `services/images.ts` garde le cache sous `IMAGE_CACHE_MAX_MB`. Chaque lecture rafraîchit la date de modification du fichier, et après une écriture (au plus une fois par minute) les fichiers les moins récemment utilisés sont supprimés ; les fichiers temporaires sont ignorés.
- Joint Radarr, Sonarr et Emby de l'hôte par `host.docker.internal`. Migration depuis Seerr : import facultatif des demandes existantes (lecture de sa base SQLite) en fin de MVP.

Proxy de confiance : par défaut, l'appli ne croit les en-têtes `X-Forwarded-For`, `X-Forwarded-Proto` et `X-Forwarded-Host` que venant de la boucle locale (`127.0.0.1`, `::1`). Derrière Caddy dans un autre conteneur, renseigner la variable facultative `TRUST_PROXY` avec son adresse ou son sous-réseau (adresses ou CIDR séparés par des virgules, ex. `TRUST_PROXY=172.18.0.2`). Elle est lue une fois au démarrage. Ces en-têtes donnent l'IP du client (limite des tentatives de connexion), le HTTPS (cookie `secure`) et l'hôte (contrôle d'origine CSRF) ; venant d'une autre adresse, ils sont ignorés.

## Sécurité

Amorçage avant le premier propriétaire : tant qu'aucun propriétaire n'existe, tester et enregistrer Emby est ouvert sans session (PRODUCT §1), donc une page web malveillante pourrait, par rebinding DNS, viser l'appli sur le réseau local et la brancher sur un faux Emby. Risque accepté : la fenêtre est courte (quelques minutes, du premier lancement à la première connexion d'un administrateur Emby), limitée au réseau local, et Seerr se comporte de même. La clé enregistrée n'est jamais renvoyée vers une autre adresse, et la fenêtre se ferme dès qu'un propriétaire existe.

Webhooks entrants : `POST /api/webhooks/radarr` et `POST /api/webhooks/sonarr`, et ces deux routes seulement (liste exacte dans `plugins/auth.ts`), échappent au garde de session et au contrôle CSRF, que Radarr et Sonarr ne peuvent pas satisfaire. Elles exigent à la place un jeton aléatoire de 256 bits, en paramètre `?token=` de l'adresse (toutes versions) ou dans l'en-tête `X-Webhook-Token` (champ « Headers » des versions récentes), vérifié avant la lecture du corps (401 sinon) et comparé en temps constant (empreintes SHA-256). Le jeton est chiffré en base comme les autres secrets (réglage `webhooks`) ; c'est le seul secret envoyé au navigateur, au propriétaire seulement (`GET /api/settings/webhooks`, régénérable par `POST /api/settings/webhooks/token`, l'ancien cesse aussitôt). Dans l'adresse, il peut finir dans les journaux d'accès de Caddy : préférer l'en-tête quand la version de Radarr/Sonarr le permet, et régénérer en cas de doute. Un webhook ne fait que déclencher le recalcul d'un titre déjà connu : au pire, un jeton volé fait relire Radarr/Sonarr.

Clés d'API publiques (`docs/API.md`) : l'en-tête `X-Api-Key` sur `/api/*` est traité dans le garde de session de `plugins/auth.ts` (aucune exception publique) et authentifie comme le propriétaire qui a créé la clé, avec ses droits du moment (créateur plus propriétaire : refus). Une requête à clé n'a pas de cookie, donc pas de contrôle CSRF ni d'origine ; la clé est le seul justificatif : cookie de session et clé ensemble sont refusés (400), sans repli de l'un sur l'autre, et une clé invalide ne retombe jamais sur la session. La clé fait `ur_` + 256 bits aléatoires, montrée une seule fois ; la base ne garde que son hash SHA-256 (`api_keys`, index unique : recherche par hash, pas de comparaison de secrets). Clé inconnue, vide ou révoquée : 401, et chaque échec compte pour l'IP dans un limiteur en mémoire (10 en 5 minutes, `lib/rate-limit.ts`) ; limite atteinte : 429 pour toute requête à clé de cette IP, même valide (derrière Caddy, `TRUST_PROXY` doit être réglé, sinon tous les clients partagent la même adresse). `last_used_at` n'est réécrit qu'une fois par minute. La gestion des clés (`/api/settings/api-keys`, propriétaire) exige une session : une clé ne crée, ne liste ni ne révoque de clé. Une clé volée vaut un propriétaire jusqu'à sa révocation : c'est le prix de « agir comme son créateur ».
