# Intégrations : référence vérifiée

Légende : [V] vérifié en ligne ou dans le code source officiel, [?] à vérifier sur le mini-PC.

## Emby

Auth : `X-Emby-Token: <clé>` ou `?api_key=`. Sources : https://dev.emby.media/reference/RestAPI/ItemsService/getItems.html, https://emby.media/support/articles/Webhooks.html, https://emby.media/learn/articles/automation/events/receiving/Automation-Webhooks.html

| Besoin                | Appel                                                                                                                                     | Notes                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth utilisateur      | `POST /Users/AuthenticateByName`                                                                                                          | Corps `{Username, Pw}`. En-tête `X-Emby-Authorization: MediaBrowser Client="Request", Device="Server", DeviceId="request", Version="1.0"`. Réponse : `AccessToken`, `User.Id`, `User.Policy.IsAdministrator`, `ServerId`. [?]                                                                                               |
| Valider URL et clé    | `GET /System/Info`                                                                                                                        | `ServerName`, `Version`, `Id`. `/System/Info/Public` n'exige pas de clé ; l'appli y lit `Id` (gardé une heure) pour le lien « Regarder dans Emby ». [?]                                                                                                                                                                             |
| Utilisateurs          | `GET /Users`                                                                                                                              | Admin : `Policy.IsAdministrator`. [?]                                                                                                                                                                                                                                                                                               |
| Bibliothèques         | `GET /Library/VirtualFolders`                                                                                                             | `ItemId`, `Name`, `CollectionType`. [?]                                                                                                                                                                                                                                                                                             |
| Recherche par id      | `GET /Items?Recursive=true&IncludeItemTypes=Movie,Series&Fields=ProviderIds&AnyProviderIdEquals=tmdb.603`                                 | Format `fournisseur.id` en minuscules [V]. Le paramètre existe dans le swagger officiel [V]. Une mauvaise casse renvoie 0 résultat sans erreur. Le nom exact du fournisseur TMDB (`tmdb`) n'est pas confirmé : lire `ProviderIds` d'un item connu [?]. Repli : `HasTmdbId` et filtrage côté client.                                 |
| Bibliothèques suivies | `ParentId={ItemId}` (id d'une `VirtualFolder`) avec `Recursive=true`                                                                      | Une requête par bibliothèque suivie (le paramètre n'accepte qu'un id) ; aucune bibliothèque choisie = pas de filtre. [?]                                                                                                                                                                                                            |
| Derniers ajouts       | `GET /Items?Recursive=true&IncludeItemTypes=Movie,Series&SortBy=DateCreated&SortOrder=Descending&Limit=20&Fields=ProviderIds,DateCreated` | Rangée « Ajoutés récemment dans Emby », sans id d'utilisateur (`/Users/{id}/Items/Latest` en exigerait un). Éléments sans id TMDB écartés. [?]                                                                                                                                                                                      |
| Épisodes              | `GET /Shows/{id}/Episodes?Season=n`                                                                                                       | Ignorer `LocationType == "Virtual"`. [?]                                                                                                                                                                                                                                                                                            |
| Lien profond web      | `{base}/web/index.html#!/item?id={ItemId}&serverId={ServerId}`                                                                            | Format issu du forum, non documenté officiellement. `serverId` requis. Utilisé tel quel (3.3) : `{adresse publique}/web/index.html#!/item?id=…&serverId=…`, adresse réglée dans Réglages › Emby. [?] à confirmer sur le mini-PC : le lien ouvre la bonne fiche, et le `Id` de `/System/Info/Public` est bien le `serverId` attendu. |
| Lien natif            | `emby://items/{serverId}/{itemId}` (Android)                                                                                              | Source : forum. Hors périmètre.                                                                                                                                                                                                                                                                                                     |

### Webhooks

- Ils nécessitent Emby Premiere [V] (support.emby.media).
- Pour les événements de bibliothèque, seul `library.new` était confirmé par un message de forum ancien. Le payload ne contient aucun utilisateur [V]. La liste actuelle des événements n'est pas confirmée [?].
- Solution sans Premiere : se fier aux webhooks Radarr/Sonarr (événement Download), puis vérifier la présence dans Emby avec `/Items`.

## Radarr v3

Auth : `X-Api-Key`, base `/api/v3`. Sources : https://radarr.video/docs/api/, code https://github.com/Radarr/Radarr (branche develop).

| Besoin      | Appel                               | Notes                                                                                                                                                                                                      |
| ----------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Statut      | `GET /system/status`                | `version`.                                                                                                                                                                                                 |
| Profils     | `GET /qualityprofile`               | `id`, `name`.                                                                                                                                                                                              |
| Racines     | `GET /rootfolder`                   | `path`, `freeSpace`.                                                                                                                                                                                       |
| Lookup TMDB | `GET /movie/lookup/tmdb?tmdbId=603` | Un seul `MovieResource` [V]. Existent aussi : `/movie/lookup/imdb?imdbId=` et `/movie/lookup?term=tmdb:603`.                                                                                               |
| Ajout       | `POST /movie`                       | `title`, `tmdbId`, `year`, `qualityProfileId`, `rootFolderPath`, `monitored`, `minimumAvailability` (`announced`, `inCinemas`, `released`), `addOptions.searchForMovie`. [?] sur le détail exact du corps. |
| Liste       | `GET /movie`                        | Tous les films (`id`, `tmdbId`, `hasFile`) en un appel : statuts d'une page d'affiches sans une requête par film.                                                                                          |
| Queue       | `GET /queue?includeMovie=true`      | `records[]` : `movieId`, `size`, `sizeleft`, `timeleft`, `status`. Progression = `1 - sizeleft/size`. [?]                                                                                                  |

### Webhook

- `eventType` possibles [V] : `Test`, `Grab`, `Download`, `Rename`, `MovieDelete`, `MovieFileDelete`, `Health`, `ApplicationUpdate`, `MovieAdded`, `HealthRestored`, `ManualInteractionRequired`. Le payload contient `movie.tmdbId`. [?]
- Auth [V] : champs `Username` et `Password` (Basic), plus `Headers` personnalisés. Méthode POST ou PUT.

## Sonarr v3/v4

Auth et base identiques à Radarr. Sources : https://sonarr.tv/docs/api/, code https://github.com/Sonarr/Sonarr (branche develop).

- **TMDB vers TVDB** : `GET https://api.themoviedb.org/3/tv/{id}/external_ids` donne `tvdb_id`, parfois null. Prévoir ce cas.
- **Lookup** : `GET /series/lookup?term=tvdb:121361`. Contient `seasons[]` avec `seasonNumber` et `monitored`.
- **Ajout** : `POST /series`.
  - Champs : `title`, `tvdbId`, `qualityProfileId`, `rootFolderPath`, `monitored`, `seasonFolder`, `seriesType` (`standard`, `anime`, `daily`), `seasons[].monitored`.
  - `addOptions` contient `searchForMissingEpisodes` et `searchForCutoffUnmetEpisodes` [V]. Il hérite aussi des options de `monitor` (mode de monitoring) [V], mais leur détail est [?].
  - `languageProfileId` est obsolète : le code renvoie toujours 1 en lecture seule [V]. Ne pas l'envoyer en v4. En v3 pur, il peut encore être exigé [?].
- **Disponibilité** : `GET /episode?seriesId=X` (`seasonNumber`, `hasFile`, `monitored`), ou `series.statistics.seasons[]`. [?]
- **Liste** : `GET /series` donne toutes les séries avec `tvdbId`, `seasons[].statistics` (`episodeFileCount`, `episodeCount`, `totalEpisodeCount`) et, en v4, `tmdbId` [?]. Sans `tmdbId` (v3), l'appli passe par `tmdb.tvdbIdFor` puis garde l'id TVDB dans `media.tvdb_id`.
- **Queue** : `GET /queue?includeSeries=true&includeEpisode=true`, avec les mêmes champs que Radarr. [?]
- **Webhook** : `series` contient `id`, `title`, `path`, `tvdbId`, `tvMazeId`, `tmdbId`, `imdbId`, `type`, `year`, `genres`, `images`, `tags`, `originalLanguage` [V] (code actuel de la branche develop). `tmdbId` est donc présent en v4 récent, pas garanti en v3 [?]. `episodes[]` contient `seasonNumber` et `episodeNumber` ; `eventType` vaut `Download` [?].
- **Auth du webhook** [V] : identique à Radarr (`Username`, `Password`, `Headers`, `Method`). Doc : https://wiki.servarr.com/sonarr/settings#connections

### Webhooks reçus par l'appli (5.1)

- Adresses : `POST /api/webhooks/radarr` et `POST /api/webhooks/sonarr` (méthode **POST** à choisir dans *arr, PUT refusé). Jeton en `?token=` dans l'adresse (toutes versions) ou en-tête `X-Webhook-Token` via `Headers` (versions récentes [?]) ; adresses et jeton dans `GET /api/settings/webhooks` (propriétaire). L'adresse est construite depuis celle par laquelle le propriétaire joint l'appli : que Radarr/Sonarr la joignent aussi (réseau Docker) est [?].
- Évènements traités : `Grab`, `Download`, `MovieDelete`, `MovieFileDelete` (Radarr [V]) ; `SeriesDelete`, `EpisodeFileDelete`, `ImportComplete` (Sonarr [?]) ; `Test`. Les autres reçoivent 200 et sont ignorés.

## TMDB v3

Sources : https://developer.themoviedb.org/docs/authentication-application, https://developer.themoviedb.org/docs/rate-limiting, https://developer.themoviedb.org/reference/intro/getting-started

- **Auth** : `Authorization: Bearer <read access token>` (recommandé), ou `?api_key=`.
- **Limites** [V] : environ 40 requêtes par seconde ; l'ancienne règle de 40 requêtes par 10 s a été supprimée en décembre 2019. Les limites peuvent changer ; gérer le 429 par un retry avec temporisation, et mettre en cache.

| Besoin     | Chemin                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| Tendances  | `/trending/{movie\|tv\|all}/{day\|week}`                                                                                    |
| Populaires | `/movie/popular`, `/tv/popular`                                                                                             |
| À venir    | `/movie/upcoming` ; pour les séries, `/tv/on_the_air` [?]                                                                   |
| Discover   | `/discover/movie` ou `/discover/tv` avec `with_watch_providers=<id>&watch_region=FR&with_watch_monetization_types=flatrate` |
| Recherche  | `/search/multi?query=&language=fr-FR`                                                                                       |
| Détails    | `/movie/{id}` ou `/tv/{id}` avec `append_to_response=credits,videos,recommendations,similar,watch/providers,external_ids`   |
| Images     | `https://image.tmdb.org/t/p/{taille}{path}`, tailles listées par `/configuration` : `w92` à `w780`, `w1280`, `original`     |

- **Langue** : `language=fr-FR`. Si `overview` ou `title` sont vides, refaire la requête en `en-US` pour ces champs. Pour les vidéos : `include_video_language=fr,en,null`.
- **Mentions** : l'attribution TMDB est obligatoire. Les données de watch/providers viennent de JustWatch.

## Seerr (Jellyseerr, Overseerr) : import des demandes (6.2)

Auth : `X-Api-Key: <clé>` (Paramètres › Général), base `/api/v1`. Sources : code de https://github.com/seerr-team/seerr (branche develop) : `server/routes/request.ts`, `server/entity/User.ts`, `server/constants/media.ts`. L'adresse et la clé servent à l'appel seulement, jamais enregistrées (`POST /api/import/seerr`, propriétaire).

- **Demandes** [V] : `GET /request?take=100&skip=n&filter=all`. Réponse `{ pageInfo: { pages, pageSize, results, page }, results: [] }`, où `pageInfo.results` est le total. `filter=all` (ou absent) couvre les cinq statuts. Plafond éventuel de `take` côté serveur non vu : `skip` avance donc du nombre de demandes reçues [?].
- **Demande** [V] : `id`, `status`, `type` (`movie`/`tv`), `is4k`, `createdAt`, `updatedAt`, `media` (`mediaType`, `tmdbId`, `tvdbId`, `status`, `status4k`), `seasons[].seasonNumber`, `requestedBy`. Format des dates selon la base (SQLite ou Postgres) [?].
- **Statuts** [V] : demande 1 en attente, 2 approuvée, 3 refusée, 4 échec, 5 terminée ; média 1 inconnu, 2 en attente, 3 en cours, 4 partiel, 5 disponible, 6 bloqué, 7 supprimé. Les statuts de demande 4 et 5 n'existent que dans Jellyseerr/Seerr récents ; Overseerr s'arrête à 3 [?].
- **Membre** : `requestedBy` est l'entité `User` chargée en entier [V] : `id`, `email`, `username`, `plexUsername`, `jellyfinUsername`, `jellyfinUserId`, `userType`, `displayName` (= `username` › `plexUsername` › `jellyfinUsername` › `email`). Pas de champ `embyUserId` : un compte Emby range son id Emby dans `jellyfinUserId` [?], format (tirets, casse) [?].

Correspondances (`services/seerr-import.ts`) :

- **Membre** : `jellyfinUserId` comparé à l'id Emby du membre, sans casse ni tirets ; sinon `jellyfinUsername`, `username`, `plexUsername`, `displayName` comparés au nom du membre, sans casse (un nom porté par deux membres ne compte pas). Aucun membre créé : les demandes d'un compte sans correspondance sont écartées et listées.
- **Statut** : 1 → `pending` ; 2 → `sent` (déjà envoyée par Seerr, jamais renvoyée), ou `available` si le média (`status4k` pour une 4K) vaut 5 ; 3 → `declined` ; 4 → `failed` (relançable) ; 5 → `available`. Autre statut, titre sans `tmdbId`, série sans saison : écartée (« titre non reconnu »).
- **4K** : gardée (`is_4k = 1`), la colonne existant déjà ; `markAvailable` ne la fait jamais passer disponible avec la version ordinaire.

## Discord (5.3)

Facultatif, désactivé par défaut. Source : https://discord.com/developers/docs/resources/webhook#execute-webhook

- **Réglage** : Réglages › Notifications Discord (propriétaire), hors assistant. Adresse du webhook, interrupteur, évènements envoyés (`requested`, `approved`, `declined`, `available`, `failed`). `GET/PUT /api/settings/discord` et `POST /api/settings/discord/test`. L'adresse est un secret : chiffrée en base, renvoyée seulement sous la forme `{ set: true }`, gardée si le champ est laissé vide à l'enregistrement.
- **Adresse acceptée** : `https://discord.com/api/webhooks/{id}/{jeton}` ou `discordapp.com`, rien d'autre (aucun appel sortant vers un hôte choisi par l'utilisateur).
- **Appel** : `POST {adresse}` avec `{ embeds: [{ title, description, color, timestamp, fields, thumbnail }], allowed_mentions: { parse: [] } }`. Réponse 204 sans corps (sans `?wait=true`) [V]. `allowed_mentions` vide : un titre ou un motif ne peut pas mentionner `@everyone`. Limites : 1024 caractères par champ, 4096 pour la description (textes tronqués). Limite de débit (429) : pas de nouvelle tentative, le message est perdu.
- **Contenu** (en français) : titre court de l'évènement (« Demande approuvée »), `**Titre** (année)`, champ « Demandé par », champ « Motif » (refus) ou « Raison » (échec). Un message par évènement, pas par destinataire : l'acteur n'est pas exclu, un salon n'est pas un destinataire. Mêmes évènements que la cloche : une nouvelle demande d'un rôle à approbation automatique n'envoie pas « à approuver », ni les saisons ajoutées à une demande déjà en attente.
- **Affiche** : l'adresse TMDB publique (`https://image.tmdb.org/t/p/w342/…`) en vignette ; `/api/images` exige une session, Discord ne peut pas la lire. Sans affiche connue, pas de vignette.
- **Envoi** : après la validation de la transaction de l'évènement, sans attendre (l'action du membre n'en dépend jamais), délai de 5 s, aucune nouvelle tentative. L'évènement n'est envoyé que s'il est bien en base (une transaction annulée n'envoie rien). Désactivé ou sans adresse : aucun appel, ni vers Discord ni vers TMDB.
- **Journal** : l'échec est journalisé sans l'adresse (le jeton est dans le chemin, que `redactUrl` ne masque pas) : seulement la nature de l'erreur et son code HTTP.
- **Tester** : poste un message « Test de Request » avec l'adresse saisie, sinon l'enregistrée. Un refus de Discord (401/403, 404 si le webhook a été supprimé) devient une 422 au message lisible.
