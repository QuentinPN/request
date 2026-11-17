# Intégrations : référence vérifiée

Légende : [V] vérifié en ligne ou dans le code source officiel, [?] à vérifier sur le mini-PC.

## Emby

Auth : `X-Emby-Token: <clé>` ou `?api_key=`. Sources : https://dev.emby.media/reference/RestAPI/ItemsService/getItems.html, https://emby.media/support/articles/Webhooks.html, https://emby.media/learn/articles/automation/events/receiving/Automation-Webhooks.html

| Besoin             | Appel                                                                                                     | Notes                                                                                                                                                                                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth utilisateur   | `POST /Users/AuthenticateByName`                                                                          | Corps `{Username, Pw}`. En-tête `X-Emby-Authorization: MediaBrowser Client="Request", Device="Server", DeviceId="request", Version="1.0"`. Réponse : `AccessToken`, `User.Id`, `User.Policy.IsAdministrator`, `ServerId`. [?]                                                               |
| Valider URL et clé | `GET /System/Info`                                                                                        | `ServerName`, `Version`, `Id`. `/System/Info/Public` n'exige pas de clé. [?]                                                                                                                                                                                                                        |
| Utilisateurs       | `GET /Users`                                                                                              | Admin : `Policy.IsAdministrator`. [?]                                                                                                                                                                                                                                                               |
| Bibliothèques      | `GET /Library/VirtualFolders`                                                                             | `ItemId`, `Name`, `CollectionType`. [?]                                                                                                                                                                                                                                                             |
| Recherche par id   | `GET /Items?Recursive=true&IncludeItemTypes=Movie,Series&Fields=ProviderIds&AnyProviderIdEquals=tmdb.603` | Format `fournisseur.id` en minuscules [V]. Le paramètre existe dans le swagger officiel [V]. Une mauvaise casse renvoie 0 résultat sans erreur. Le nom exact du fournisseur TMDB (`tmdb`) n'est pas confirmé : lire `ProviderIds` d'un item connu [?]. Repli : `HasTmdbId` et filtrage côté client. |
| Épisodes           | `GET /Shows/{id}/Episodes?Season=n`                                                                       | Ignorer `LocationType == "Virtual"`. [?]                                                                                                                                                                                                                                                            |
| Lien profond web   | `{base}/web/index.html#!/item?id={ItemId}&serverId={ServerId}`                                            | Format issu du forum, non documenté officiellement. `serverId` requis. [?]                                                                                                                                                                                                                          |
| Lien natif         | `emby://items/{serverId}/{itemId}` (Android)                                                              | Source : forum. Hors périmètre.                                                                                                                                                                                                                                                                     |

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
- **Queue** : `GET /queue?includeSeries=true&includeEpisode=true`, avec les mêmes champs que Radarr. [?]
- **Webhook** : `series` contient `id`, `title`, `path`, `tvdbId`, `tvMazeId`, `tmdbId`, `imdbId`, `type`, `year`, `genres`, `images`, `tags`, `originalLanguage` [V] (code actuel de la branche develop). `tmdbId` est donc présent en v4 récent, pas garanti en v3 [?]. `episodes[]` contient `seasonNumber` et `episodeNumber` ; `eventType` vaut `Download` [?].
- **Auth du webhook** [V] : identique à Radarr (`Username`, `Password`, `Headers`, `Method`). Doc : https://wiki.servarr.com/sonarr/settings#connections

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
