# Décisions

Journal des décisions techniques et produit. La plus récente en bas.

| Date       | Décision                                                                                                                       | Raison                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 2026-11-16 | Stack allégée : SPA (pas de SSR), REST typé par Zod (pas de GraphQL/Relay), un seul processus (pas de Watt)                    | Portail privé de quelques dizaines d'utilisateurs ; détail dans ARCHITECTURE.md       |
| 2026-11-16 | Tokens d'Hub, pas ceux d'Viewer                                                                                   | Même serveur, tokens complets (clair, densité, mouvement réduit)                      |
| 2026-11-16 | Discord facultatif, désactivé par défaut ; notifications dans l'appli d'abord                                                  | Demande du propriétaire                                                               |
| 2026-11-17 | Direction de design : page « Recommandation » du canevas (A + suivi de C, approbations B/C, assistant C)                       | Validée par le propriétaire ; détail dans DESIGN.md                                   |
| 2026-11-17 | Dépôt privé `QuentinPN/Request` ; `main` = production, `dev` = intégration, une PR par lot vers `dev`                  | Permet le mode « full auto » sans jamais toucher la production                        |
| 2026-11-17 | Pas de TASKS.md séparé : identifiants, priorités et critères dans ROADMAP.md ; risques dans CURRENT_STATUS.md                  | Éviter les doublons de suivi                                                          |
| 2026-11-17 | Lots indépendants délégués en parallèle (un worktree par `coder`), règle dans CLAUDE.md                                        | Demande du propriétaire : accélérer le développement                                  |
| 2026-11-17 | Cache disque des affiches TMDB dans le MVP ; 8 fonctions de Seerr ajoutées à « Plus tard »                                     | Comparaison avec Seerr (0.4)                                                          |
| 2026-11-17 | Quotas comptés en saisons (PRODUCT.md), alors que Seerr compte les demandes de séries                                          | Choix initial du propriétaire conservé                                                |
| 2026-11-17 | Risque de rebinding DNS accepté pendant l'amorçage d'Emby (avant le premier propriétaire)                                      | Fenêtre courte, réseau local, comme Seerr ; détail dans ARCHITECTURE.md               |
| 2026-11-17 | Un titre refusé peut être redemandé                                                                                            | Le refus porte sur une demande, pas sur le titre ; l'admin peut refuser à nouveau     |
| 2026-11-17 | Écran de connexion dérivé de la carte de l'assistant (pas de maquette dédiée)                                                  | Même famille visuelle validée ; captures `docs/captures/2.2` soumises au propriétaire |
| 2026-11-17 | `TRUST_PROXY` (facultatif) en plus du port et du dossier de données                                                            | Seul moyen sûr de faire confiance à Caddy dans Docker                                 |
| 2026-11-17 | Propriétaire et gestionnaires exemptés des quotas (`quotaExempt`)                                                              | Comme Seerr ; le quota vise les membres                                               |
| 2026-11-17 | Une série envoyée accepte de nouvelles saisons par une nouvelle demande (index `requests_active` limité aux états avant envoi) | Sinon un membre restait bloqué jusqu'à la disponibilité                               |
| 2026-11-17 | Saison en cours de diffusion dont tous les épisodes diffusés sont présents = « Disponible » (et la demande passe disponible)   | Comme Seerr ; Sonarr suit les épisodes à venir                                        |
| 2026-11-17 | Un seul jeton partagé pour les webhooks Radarr et Sonarr, en paramètre ou en-tête                                              | Configuration simple ; régénérable par le propriétaire                                |
| 2026-11-17 | Demandes 4K : non prises en charge (approbation et relance refusées) ; l'import Seerr ignore les 4K en attente                 | Pas de Radarr/Sonarr 4K sur le serveur                                                |
| 2026-11-17 | Discord : un message par événement, envoyé après validation de la transaction, sans nouvelle tentative                         | Facultatif, ne doit jamais bloquer ni dupliquer                                       |
