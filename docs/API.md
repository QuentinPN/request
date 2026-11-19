# API publique

Request expose son API REST (`/api/*`) aux scripts et outils externes (Home Assistant, Tautulli, un bot…) par des **clés d'API**, créées dans Réglages › API (propriétaire seulement).

## Authentification

Envoyer la clé dans l'en-tête `X-Api-Key` de chaque requête :

```sh
curl -H "X-Api-Key: ur_…" https://requetes.exemple.fr/api/auth/me
```

- La requête agit **comme le propriétaire qui a créé la clé, avec ses droits du moment** : une clé a donc les droits d'un propriétaire (réglages et secrets masqués compris). Si son créateur n'est plus propriétaire, la clé est refusée.
- Pas de cookie, donc **ni en-tête `X-Request` ni contrôle d'origine** à fournir, y compris pour les écritures (`POST`, `PUT`, `DELETE`).
- **Cookie de session, clé et jeton Bearer ne se combinent pas** : une requête qui en porte plusieurs est refusée (400), sans repli de l'un sur l'autre. Un client à clé n'envoie aucun cookie.
- Clé inconnue, vide ou révoquée : `401`. Après 10 clés invalides en 5 minutes depuis une même adresse IP, cette adresse reçoit `429` (en-tête `Retry-After`) pour toute requête à clé, même valide.
- Une clé ne gère pas les clés ni les sessions : `GET`, `POST` et `DELETE /api/settings/api-keys`, `GET /api/auth/sessions` et `DELETE /api/auth/sessions/{id}` répondent `403` à une requête à clé.
- Les erreurs sont du JSON `{ "error": "message" }`.

## Clés

- La clé complète (`ur_` + 43 caractères) n'est affichée **qu'une fois**, à sa création. Le serveur ne garde que son empreinte SHA-256 : une clé perdue ne se retrouve pas, il faut en créer une autre.
- Le nom, le préfixe (`ur_` + 5 caractères), le créateur, la date de création et de dernière utilisation (à la minute près) sont visibles dans la liste.
- Révoquer une clé la désactive aussitôt ; elle reste listée.

## Routes utiles

Les routes d’un membre (connexion et sessions, catalogue, images et photos des membres, ses demandes, Ma liste, notifications) sont décrites en OpenAPI 3.1 dans [`docs/openapi.json`](openapi.json), généré depuis les schémas Zod par `npm run openapi` ; un test échoue s’il n’est plus à jour.

| Besoin                     | Appel                                                                                           | Droit requis                                                                                                                                                                                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version de l'API           | `GET /api/version`                                                                              | public (sans session)                                                                                                                                                                                                                                                              |
| Vérifier la clé            | `GET /api/auth/me`                                                                              | tout membre                                                                                                                                                                                                                                                                        |
| Chercher un titre          | `GET /api/search?q=dune&page=1`                                                                 | tout membre                                                                                                                                                                                                                                                                        |
| Fiche et statut d'un titre | `GET /api/media/{movie\|tv}/{tmdbId}`                                                           | tout membre                                                                                                                                                                                                                                                                        |
| Rangées de Découvrir       | `GET /api/discover`                                                                             | tout membre                                                                                                                                                                                                                                                                        |
| Films ou séries filtrés    | `GET /api/discover/{movie                                                                       | tv}?genres=28,12&yearFrom=2000&yearTo=2010&rating=7&runtimeMin=90&runtimeMax=150&language=fr&provider=8&sort=rating&company=1&network=2&page=1`(tous optionnels ;`sort`:`popularity`, `rating`, `release`, `title`; durée et`company`: films,`network` : séries ; 400 si invalide) | tout membre |
| Créer une demande          | `POST /api/requests` `{ "type": "movie", "tmdbId": 693134 }`                                    | peut demander                                                                                                                                                                                                                                                                      |
| Demande d'une série        | `POST /api/requests` `{ "type": "tv", "tmdbId": 1399, "seasons": [1, 2] }` (`"all"` par défaut) | peut demander                                                                                                                                                                                                                                                                      |
| Lister les demandes        | `GET /api/requests?status=pending&type=movie&mine=true&page=1`                                  | peut demander                                                                                                                                                                                                                                                                      |
| Détail d'une demande       | `GET /api/requests/{id}`                                                                        | peut demander                                                                                                                                                                                                                                                                      |
| Quota restant              | `GET /api/requests/quota`                                                                       | peut demander                                                                                                                                                                                                                                                                      |
| Approuver / refuser        | `POST /api/requests/{id}/approve`, `POST /api/requests/{id}/decline` `{ "reason": "…" }`        | gestionnaire                                                                                                                                                                                                                                                                       |
| Annuler une demande        | `POST /api/requests/{id}/cancel`                                                                | peut demander                                                                                                                                                                                                                                                                      |

`GET /api/version` répond `{ "apiVersion": "1.0.0", "features": ["api-version"] }` sans session : un client natif compare `apiVersion` (semver) à celle qu'il exige et teste la présence d'un nom dans `features` avant d'appeler une route récente.

Le **statut** d'un titre (`status` dans la fiche et dans les résultats de recherche) dit s'il est disponible dans Emby, demandé, en attente d'approbation, etc. ; un titre absent de la bibliothèque et jamais demandé n'a pas de `status`.

La fiche porte aussi `embyItemId` : l'id de l'élément sur le serveur multimédia (Emby, Jellyfin ou Plex) quand le titre y est disponible ou partiel (même s'il est aussi demandé), `null` sinon. Un client natif s'en sert pour proposer « Lire ». Les listes (recherche, Découvrir) ne l'envoient que lorsqu'il existe.

Avec une clé, ces routes voient ce que voit son créateur (un propriétaire : toutes les demandes). Les autres routes de l'application (`/api/*`) acceptent aussi la clé ; les formats exacts sont les contrats Zod de `src/shared`.

## Webhook sortant (Réglages › Webhook sortant)

Le propriétaire peut recevoir chaque évènement d'une demande dans ses propres outils : un `POST` JSON vers son adresse (`http` ou `https`), avec, s'il est renseigné, l'en-tête `Authorization` saisi (chiffré en base, jamais renvoyé). Un message par évènement (pas un par destinataire), envoyé après la validation de l'évènement, **sans nouvelle tentative** ; seul le statut de la réponse compte (2xx attendu, délai 5 s). Un échec est journalisé sans l'adresse ni l'en-tête et n'affecte pas la demande.

Corps, toujours ces six champs (`OutgoingWebhookPayload`, `src/shared/agents.ts`) :

```json
{
  "type": "requested",
  "title": "Nouvelle demande à approuver",
  "message": "Matrix (1999)\nDemandé par Alice",
  "media": { "type": "movie", "tmdbId": 603, "title": "Matrix" },
  "request": { "id": 12, "status": "pending" },
  "user": { "name": "Alice" }
}
```

| Champ     | Contenu                                                                                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`    | `requested`, `approved`, `auto_approved`, `declined`, `available`, `failed`, ou `test` (bouton « Tester »)                                                        |
| `title`   | Titre court, en français (« Demande approuvée », « Demande approuvée automatiquement »…)                                                                          |
| `message` | Lignes séparées par `\n` : titre et année, « Demandé par … », puis « Motif : … » (refus) ou « Raison : … » (échec)                                                |
| `media`   | `{ type: "movie" \| "tv", tmdbId, title }` ; `title` vaut `null` si TMDB ne répond pas ; `null` pour `test`                                                       |
| `request` | `{ id, status }` : statut de la demande au moment de l'envoi (`pending`, `approved`, `declined`, `cancelled`, `sent`, `failed`, `available`) ; `null` pour `test` |
| `user`    | `{ name }` : le membre qui a demandé ; `null` pour `test`                                                                                                         |

`auto_approved` : demande approuvée sans passer par un gestionnaire (droits du membre) ; il remplace `approved` pour cette demande. Chaque agent (Discord, ntfy, Telegram, webhook sortant) choisit les types qu'il reçoit.

## Clients natifs

Les applications natives (Viewer, Windows et Android TV) ouvrent une session avec le **jeton d'accès Emby ou Jellyfin** qu'elles détiennent déjà pour le membre, sans son mot de passe :

```http
POST /api/auth/emby-token
Content-Type: application/json

{ "userId": "…", "accessToken": "…", "deviceName": "Salon (Android TV)" }
```

- `userId` : id du compte (1 à 64 caractères : lettres, chiffres, `_`, `-`) ; `accessToken` : jeton du membre (1 à 512 caractères, sans espace ni guillemet) ; `deviceName` : nom de l'appareil, rogné, 1 à 64 caractères sans caractère de contrôle.
- Request demande au serveur multimédia, avec ce jeton, s'il vaut pour `userId` (comparé sans casse ni tirets) : Jellyfin, `GET /Users/Me` ; Emby (sans `/Users/Me`), `GET /Sessions` avec un appareil de vérification neuf à chaque connexion (`request-verify-<nonce>`) : la session qu'Emby crée pour cet appareil doit appartenir à ce compte. Chaque connexion par jeton laisse une entrée « Verification Viewer » dans Emby › Appareils (rare : la session dure ensuite 30 jours), à nettoyer au besoin. Jeton refusé, autre compte, compte désactivé ou inconnu : `401`. Serveur injoignable : `502`, comme `POST /api/auth/login`.
- Réponse `200` : `{ "token", "expiresAt", "viewer" }` (`embyTokenSessionSchema`, `src/shared/auth.ts`). Le jeton de session n'est montré qu'une fois et expire 30 jours après sa dernière utilisation. **Aucun cookie** n'est posé : le client l'envoie ensuite en `Authorization: Bearer` (ci-dessous).
- Ni en-tête `X-Request` ni contrôle d'origine (pas de cookie, donc pas de CSRF). Limite partagée avec la connexion par mot de passe : 10 essais par adresse IP en 5 minutes, puis `429` (`Retry-After`).
- Serveur Plex, ou aucun serveur : `400`. Corps invalide : `400`.
- Le jeton Emby/Jellyfin n'est ni conservé ni journalisé.

### Jeton de session en Bearer

Le jeton reçu s'envoie dans l'en-tête `Authorization` de chaque requête :

```http
GET /api/auth/me
Authorization: Bearer <token>
```

- Accepté sur toutes les routes `/api`, `/api/images` comprise. La requête a **le rôle et les droits réels du membre** de la session (un membre reçoit `403` sur une route de gestionnaire), pas ceux du propriétaire comme une clé d'API.
- Ni en-tête `X-Request` ni contrôle d'origine, y compris pour les écritures : pas de cookie, donc pas de CSRF.
- Même durée que la session de navigateur : 30 jours après la dernière utilisation (l'utilisation la prolonge).
- **Jamais dans l'adresse** : `?token=` ou `?access_token=` ne sont pas lus (une adresse finit dans les journaux).
- Erreurs : jeton `Bearer` inconnu, expiré, révoqué, vide ou malformé : `401`, sans repli sur un cookie. Les autres schémas (`Basic`…) sont ignorés : avec un cookie, la session du cookie sert ; seuls, ils sont sans effet (route publique normale, `401` « non connecté » sur une route protégée, hors limiteur). Bearer avec cookie de session ou `X-Api-Key` : `400`. Après 10 jetons invalides en 5 minutes depuis une même adresse IP : `429` (`Retry-After`) pour tout jeton invalide ; un jeton valide passe toujours.
- L'en-tête `Authorization` est lu sur toute route `/api`, publiques comprises : ne pas l'envoyer à `POST /api/auth/emby-token` (un jeton périmé y donnerait `401` au lieu d'une nouvelle connexion).

### Sessions et déconnexion

- `GET /api/auth/sessions` : sessions en cours du membre, la plus récemment utilisée d'abord : `{ "sessions": [{ "id", "deviceName", "userAgent", "createdAt", "lastSeenAt", "expiresAt", "current" }] }` (`authSessionsSchema`, `src/shared/auth.ts`). `deviceName` : nom donné à la connexion par jeton, `null` pour un navigateur ; `userAgent` : résumé (« Firefox · Windows », sinon le premier produit, ex. `okhttp/4.12.0`), `null` s'il manquait ; `current` : la session de la requête. `id` : identifiant opaque (32 hexadécimaux), ni le jeton ni son empreinte.
- `DELETE /api/auth/sessions/{id}` : révoque l'une de ses sessions (`204`), la courante comprise ; `404` si l'id n'est pas celui d'une de ses sessions, `400` s'il est malformé.
- `POST /api/auth/logout` en Bearer révoque la session du jeton (`204`, aucun cookie touché).
- Valables par cookie (avec `X-Request` pour `DELETE`) comme en Bearer, pour tout membre ; `403` avec une clé d'API. Les routes de gestion des clés d'API (`/api/api-keys`) refusent aussi le Bearer (`403`) : un jeton volé ne peut pas créer une clé qui survivrait à la révocation de la session. « Déconnecter partout » (propriétaire, `DELETE /api/users/{id}/sessions`) révoque aussi les jetons des appareils.
