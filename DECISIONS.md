# Décisions

Journal des décisions techniques et produit. La plus récente en bas.

| Date       | Décision                                                                                                      | Raison                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 2026-11-16 | Stack allégée : SPA (pas de SSR), REST typé par Zod (pas de GraphQL/Relay), un seul processus (pas de Watt)   | Portail privé de quelques dizaines d'utilisateurs ; détail dans ARCHITECTURE.md |
| 2026-11-16 | Tokens d'Hub, pas ceux d'Viewer                                                                  | Même serveur, tokens complets (clair, densité, mouvement réduit)                |
| 2026-11-16 | Discord facultatif, désactivé par défaut ; notifications dans l'appli d'abord                                 | Demande du propriétaire                                                         |
| 2026-11-17 | Direction de design : page « Recommandation » du canevas (A + suivi de C, approbations B/C, assistant C)      | Validée par le propriétaire ; détail dans DESIGN.md                             |
| 2026-11-17 | Dépôt privé `QuentinPN/Request` ; `main` = production, `dev` = intégration, une PR par lot vers `dev` | Permet le mode « full auto » sans jamais toucher la production                  |
| 2026-11-17 | Pas de TASKS.md séparé : identifiants, priorités et critères dans ROADMAP.md ; risques dans CURRENT_STATUS.md | Éviter les doublons de suivi                                                    |
