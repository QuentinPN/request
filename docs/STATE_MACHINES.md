# Machines à états

États, invariants et transitions des machines explicites (colonne de statut) et implicites (états dérivés, verrous, états client) d'Request. Les chemins sont relatifs à `src/`. À tenir à jour à chaque nouvelle transition.

## 1. Demande (`requests.status`)

États : `pending`, `approved`, `sent`, `failed`, `declined`, `cancelled`, `available` (`shared/status.ts`, contrainte CHECK dans `server/db/schema.ts`). Une demande 4K suit la même machine sur le serveur 4K.

| De → vers                                  | Déclencheur                                         | Fonction (`server/services/requests.ts`) | Garde                                                                                                    |
| ------------------------------------------ | --------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| ∅ → `pending` / `approved`                 | création (approbation auto selon le rôle)           | `create`                                 | quota, blocages, transaction `immediate`, index unique `requests_active`                                 |
| `pending` → `approved`                     | approbation                                         | `approve` → `transition`                 | `UPDATE … WHERE status IN ('pending')`                                                                   |
| `approved` → `sent` / `failed`             | envoi à Radarr/Sonarr                               | `send`                                   | `WHERE status = 'approved'`                                                                              |
| `failed` → `approved`                      | relance                                             | `retry`                                  | `from = ['failed']`                                                                                      |
| `pending`, `failed` → `declined`           | refus                                               | `decline`                                | `from` explicite                                                                                         |
| `pending` → `cancelled`                    | annulation par le membre                            | `cancel`                                 | `from = ['pending']`, propriétaire de la demande                                                         |
| `approved` → `failed`                      | redémarrage pendant un envoi                        | `failInterruptedSends`                   | `WHERE status = 'approved'`                                                                              |
| `sent`, `approved`, `failed` → `available` | titre (et toutes les saisons demandées) disponibles | `markAvailable`                          | non 4K : `sent`/`approved`/`failed` ; 4K : `sent` seulement ; série : chaque saison demandée `available` |

Invariants :

- Au plus une demande active (avant `available`/`declined`/`cancelled`) par (titre, membre, 4K) : index unique partiel `requests_active`.
- Toute transition est un `UPDATE … WHERE status IN (from)` : deux approbations concurrentes n'envoient qu'une fois ; un `send` en vol ne réécrit pas `sent` sur une demande devenue `available`.
- Une demande de série n'est `available` que si chacune de ses saisons l'est.
- `available`, `declined`, `cancelled` sont terminaux.

## 2. Disponibilité (`media.status`, `media.status_4k`, `seasons`, `seasons_4k`)

En base : `available`, `partial`, `downloading` ou `NULL` (absent). `requested`, `pending`, `declined` ne sont que des statuts d'affichage fusionnés avec les demandes (`displayStatus`, `server/services/availability.ts`). Le statut 4K se calcule depuis les serveurs 4K seulement.

| Transition                            | Déclencheur                                                       | Fonction (`availability.ts`) |
| ------------------------------------- | ----------------------------------------------------------------- | ---------------------------- |
| tout → recalculé                      | affichage d'une fiche, webhook « Download »/suppression, balayage | `resolve` → `writeUpdates`   |
| tout sauf `available` → `downloading` | webhook « Grab »                                                  | `markDownloading`            |

Invariants : un webhook « Grab » ne fait jamais régresser `available` (garde par titre et par saison). Un rescan du serveur multimédia est différé de 30 s au plus (debounce) ; un webhook reçu pendant la fenêtre est relu ensuite.

## 3. Signalement (`issues.status`)

États : `open`, `resolved` (`shared/issues.ts`). CHECK : `status = 'resolved'` ⇔ `resolved_at` non nul.

| De → vers           | Fonction (`server/services/issues.ts`) | Garde                                                                                                                      |
| ------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| ∅ → `open`          | `create`                               | titre disponible ou partiel ; pas de signalement ouvert identique du même membre (même titre, type, saison, épisode) → 409 |
| `open` → `resolved` | `transition`                           | `WHERE status = 'open'`, sinon 409                                                                                         |
| `resolved` → `open` | `transition`                           | idem, droit « Gérer les signalements »                                                                                     |

Un commentaire ne change pas le statut (commenter un signalement résolu est permis).

## 4. Notifications

État : `read_at` nul (non lue) → non nul (lue), sans retour. `notify()` (`server/services/notifications.ts`) écrit dans la transaction de l'évènement ; la distribution aux canaux (Discord, courriel, push) part après validation (`after-commit.ts`), sans nouvelle tentative, et n'échoue jamais la requête. Les notifications lues depuis plus de 90 jours, ou non lues depuis plus de 365 jours, sont purgées par la synchro.

## 5. Abonnement push

Ligne `push_subscriptions` unique par `endpoint` : créée ou réattribuée à l'abonnement, supprimée par le membre, sur réponse 404/410 du service, ou si le domaine n'est pas un service push connu.

## 6. Imports

- **Liste de souhaits (Trakt, Letterboxd)** : verrou mémoire par membre (libre → occupé → libre en `finally`, 409 si occupé). L'aperçu n'écrit rien ; l'import relit la source et insère avec `onConflictDoNothing`.
- **Seerr** : chaque demande importée porte `external_ref = seerr:<id>` (unique) ; lots de 200 par transaction ; l'aperçu s'exécute dans une transaction annulée. Une relance n'importe jamais deux fois la même demande Seerr.

## 7. Clé d'API

Créée → révoquée (terminal, idempotent). L'authentification refuse une clé révoquée ou dont le créateur n'est plus propriétaire. `last_used_at` n'est qu'une annotation.

## 8. Installation

Aucun état stocké : dérivé à chaque appel (`server/routes/setup.ts`).

| État      | Condition                                        | Effet                                             |
| --------- | ------------------------------------------------ | ------------------------------------------------- |
| Amorçage  | aucun propriétaire                               | réglage du serveur multimédia ouvert sans session |
| Incomplet | propriétaire, une section manque                 | le propriétaire est redirigé vers `/assistant`    |
| Complet   | serveur multimédia, TMDB, Radarr, Sonarr, règles | navigation normale                                |

Invariants : le type de serveur multimédia est figé dès qu'un membre existe (`refuseKindChange`) ; le dernier serveur Radarr ou Sonarr non 4K ne peut pas être supprimé (409), sinon l'installation redeviendrait incomplète.

## 9. Session et connexion Plex

- **Session** : créée à la connexion, expiration glissante de 30 jours, révoquée à la déconnexion ; les sessions expirées sont purgées par la synchro. Le rôle est relu à chaque requête. Le balayage complet lit les comptes du serveur multimédia et révoque les sessions des membres dont le compte a disparu ou est désactivé (Emby, Jellyfin : compte supprimé ou `Policy.IsDisabled` ; Plex : plus d'accès partagé) ; serveur injoignable, ou liste sans membre actif non administrateur : rien n'est révoqué ; un propriétaire absent n'est déconnecté que si un autre figure encore dans la liste. Le propriétaire peut aussi déconnecter un membre partout (`DELETE /api/users/:id/sessions`). Un compte désactivé ne peut pas se reconnecter : le serveur multimédia refuse l'authentification.
- **PIN Plex** (`server/routes/auth.ts`) : `pending` (en mémoire, lié à un cookie signé) → `checking` (échange exclusif) → consommé (`authorized`) ou supprimé (expiré, 410). Sur erreur passagère de plex.tv, le PIN est remis et le sondage suivant peut aboutir. Côté client (`client/pages/connexion.tsx`), le sondage s'arrête sur une erreur définitive (< 500) et continue sur une erreur passagère.

## 10. Serveurs Radarr/Sonarr

Exactement un serveur par défaut par couple (type, 4K) dès qu'il en existe un : index unique partiel et `ensureDefaults` dans la même transaction que chaque création, modification ou suppression. Le type et la 4K d'un serveur visé par une demande active ne changent pas (409).

## 11. Tâches périodiques

Verrou en base `job_runs_running` (une exécution par tâche), libéré au démarrage par `failOrphanJobs` ; garde de processus dans `startPeriodic` (un tour à la fois, arrêt qui attend le tour en cours).

## Défauts trouvés et corrigés (2026-11-18)

| Défaut                                                                                         | Correctif                                                             |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Demande `approved`/`failed` dont le titre arrive : bloquée à vie, empêche une nouvelle demande | `markAvailable` accepte ces statuts (non 4K)                          |
| Série : demande passée `available` sans ses saisons demandées                                  | `markAvailable` exige chaque saison demandée                          |
| Quota contourné : saisons ajoutées à une vieille demande en attente comptées à sa date         | `request_seasons.created_at` (migration 0011), quota par date d'ajout |
| Erreur passagère de plex.tv : PIN perdu, connexion à recommencer                               | PIN remis sauf s'il a expiré                                          |
| Sondage du PIN qui continue en boucle après une erreur définitive                              | arrêt sur erreur < 500                                                |
| Double clic sur « Signaler » : deux signalements, notifications en double                      | 409 si un signalement ouvert identique existe                         |
| Import Seerr relancé : demande fondue dans une autre recréée en double                         | évènement « Fusionnée depuis Seerr » cherché avant insertion          |
| Import Seerr : saisons perdues quand le membre a déjà une demande envoyée                      | saisons non couvertes reprises dans une demande en attente            |
| Suppression du dernier serveur Radarr/Sonarr : propriétaire renvoyé vers l'assistant           | 409 sur le dernier serveur non 4K d'un type                           |
| Sessions expirées jamais purgées                                                               | purge au balayage complet                                             |
| Membre désactivé ou retiré du serveur multimédia : session valide 30 jours                     | révoquée au balayage complet ; route « Déconnecter partout »          |
| Notifications non lues jamais purgées : table non bornée                                       | non lues de plus de 365 jours purgées au balayage complet             |

## Défauts connus, non corrigés

- **« Déconnecter partout » sans interface** : la route propriétaire existe (`DELETE /api/users/:id/sessions`), mais le client n'a aucune page de gestion des membres où placer l'action ; à décider avec la page.
- **Dernier membre retiré du serveur** : le balayage ne révoque pas quand la liste du serveur ne contient plus que des administrateurs (réponse partielle indiscernable) ; « Déconnecter partout » le couvre.
- **Amorçage ouvert** : tant qu'aucun propriétaire ne s'est connecté, n'importe qui peut régler le serveur multimédia ; installer et se connecter aussitôt après le démarrage.
- **Changement d'instance** : seul le type de serveur multimédia est figé, pas son URL.
- **Import Seerr** : les demandes importées refusées ou envoyées n'ont pas de `decided_by` ; des saisons Seerr sur un titre dont la demande est `approved`/`failed` ne sont pas reprises (comme le 409 du parcours normal).
- **Distribution après annulation** : course théorique très étroite (id réutilisé dans la même seconde) pouvant doubler un courriel ou un push.
