# API publique

Request expose son API REST (`/api/*`) aux scripts et outils externes (Home Assistant, Tautulli, un bot…) par des **clés d'API**, créées dans Réglages › API (propriétaire seulement).

## Authentification

Envoyer la clé dans l'en-tête `X-Api-Key` de chaque requête :

```sh
curl -H "X-Api-Key: ur_…" https://requetes.exemple.fr/api/auth/me
```

- La requête agit **comme le propriétaire qui a créé la clé, avec ses droits du moment** : une clé a donc les droits d'un propriétaire (réglages et secrets masqués compris). Si son créateur n'est plus propriétaire, la clé est refusée.
- Pas de cookie, donc **ni en-tête `X-Request` ni contrôle d'origine** à fournir, y compris pour les écritures (`POST`, `PUT`, `DELETE`).
- **Cookie de session et clé ne se combinent pas** : une requête qui porte les deux est refusée (400), sans repli de l'un sur l'autre. Un client à clé n'envoie aucun cookie.
- Clé inconnue, vide ou révoquée : `401`. Après 10 clés invalides en 5 minutes depuis une même adresse IP, cette adresse reçoit `429` (en-tête `Retry-After`) pour toute requête à clé, même valide.
- Une clé ne gère pas les clés : `GET`, `POST` et `DELETE /api/settings/api-keys` répondent `403` à une requête à clé.
- Les erreurs sont du JSON `{ "error": "message" }`.

## Clés

- La clé complète (`ur_` + 43 caractères) n'est affichée **qu'une fois**, à sa création. Le serveur ne garde que son empreinte SHA-256 : une clé perdue ne se retrouve pas, il faut en créer une autre.
- Le nom, le préfixe (`ur_` + 5 caractères), le créateur, la date de création et de dernière utilisation (à la minute près) sont visibles dans la liste.
- Révoquer une clé la désactive aussitôt ; elle reste listée.

## Routes utiles

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
