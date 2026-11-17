# État actuel

Mis à jour à la fin de chaque session. Point d'entrée pour reprendre le travail.

## Où on en est (2026-11-17)

- **Phases 0 à 3** : faites, sauf 0.5 (points [?] de `docs/integrations.md` à confirmer sur les vraies instances), 3.3 (lien « Regarder dans Emby », épisodes présents par saison) et 3.4 (logo : choix du propriétaire attendu).
- **Phase 4** : API des demandes (4.1, 4.2) en cours sur `feat/demandes-api` ; puis écrans Demandes, Approbations, feuille de demande (4.2, 4.3).
- **Dépôt** : `github.com/QuentinPN/Request` (privé). `main` = production (rien n'y a encore été fusionné), `dev` = intégration ; une PR par lot, CI `npm run verify`.
- **Méthode** : lots indépendants en parallèle (un worktree par agent), `checker` sur chaque PR, correctifs avant fusion.

## Ce qui existe réellement

- **Serveur** : Fastify, garde de session globale sur `/api/*` (cookie httpOnly, CSRF par en-tête + origine, proxy de confiance limité à la boucle locale ou `TRUST_PROXY`), erreurs uniformes `{ error }`.
- **Connexion** par compte Emby, premier admin Emby = propriétaire, rôles et quotas par membre, import des membres.
- **Assistant** et Réglages : Emby (bibliothèques), TMDB, Radarr, Sonarr (profils, dossiers), règles et quotas ; secrets chiffrés, jamais renvoyés.
- **Catalogue** : Découvrir (tendances, populaires, prochainement, ajoutés récemment dans Emby, plateformes), Films/Séries par genre, fiche complète, recherche `Ctrl+K`, images relayées avec cache disque.
- **Statuts** calculés côté serveur (disponible, partiel, en téléchargement avec progression) et affichés sur chaque affiche et chaque saison.
- **Base** : SQLite (WAL), migrations 0000 à 0004, modèle dans `docs/DATA_MODEL.md`.
- **Tests** : ~290 unitaires et de routes (faux Emby/Radarr/Sonarr/TMDB), ~80 e2e Playwright avec axe à 1440 et 390 px.

## Risques et points de vigilance

| Risque                                                                                                                 | Impact                                   | Traitement                                               |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| Points [?] des API (Emby `AnyProviderIdEquals`, lien profond, webhooks Premiere) non vérifiés sur les vraies instances | Statuts ou liens faux en production      | 0.5 : essai sur le mini-PC avant 6.3                     |
| Rebinding DNS pendant l'amorçage (avant propriétaire)                                                                  | Prise de contrôle pendant l'installation | Accepté, documenté ; installation courte en réseau local |
| Lignes `media` sans statut accumulées                                                                                  | Base qui grossit                         | Purge dans le balayage complet (5.1)                     |
| Disque du cache d'images sans limite                                                                                   | Espace disque                            | À borner en 6.1                                          |

## Prochaines actions

1. Fusionner l'API des demandes (4.1/4.2), puis en parallèle : écrans des demandes (feuille, Mes demandes, Approbations) et 3.3.
2. Phase 5 : webhooks Radarr/Sonarr, balayages planifiés, notifications.
3. Choix du logo par le propriétaire (3.4), puis phase 6 (Docker, déploiement).
