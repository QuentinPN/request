# État actuel

Mis à jour à la fin de chaque session. Point d'entrée pour reprendre le travail.

## Où on en est (2026-11-17)

- **Phase 0** : direction de design validée (DESIGN.md, « Direction validée »). Restent 0.4 (README de Seerr) et 0.5 (API et versions réelles), à faire avant la phase 2.
- **Phase 1** : 1.1 à 1.3 faits (`npm run verify` vert : lint, types, 11 tests unitaires, build, 6 tests Playwright). 1.4 Shell fait (navigation, routes, `Ctrl+K`, états globaux ; captures `docs/captures/1.4`). Prochain lot : **1.5** puis **1.6**.
- **Dépôt** : `github.com/QuentinPN/Request` (privé). `main` = production, `dev` = intégration.

## Ce qui existe réellement

- Serveur Fastify (`buildApp`) : `GET /api/health`, fichiers du client compilé, repli SPA. En dev, Vite route `/api/*` vers la même app (un seul port, 3000).
- Base SQLite (WAL, migrations automatiques), table `settings` ; secrets chiffrés AES-256-GCM avec une clé générée dans le dossier de données.
- Schémas Zod partagés : réglages (Emby, Radarr, Sonarr, TMDB, Discord), statuts de média et leurs libellés.
- Client : tokens, correspondance shadcn, composants (bouton, carte, affiche, pastille de statut, dialogue, squelette) sur une page de démonstration.

## Risques et points de vigilance

| Risque                                                                       | Impact                          | Traitement                        |
| ---------------------------------------------------------------------------- | ------------------------------- | --------------------------------- |
| API et versions réelles d'Emby/Radarr/Sonarr non vérifiées (0.5)             | Intégrations à reprendre        | Faire 0.5 avant la phase 2        |
| `FastifyInstance.data` déclaré non optionnel mais décoré seulement si fourni | Plantage des futures routes     | Tâche 1.5                         |
| `/api` (sans barre finale) ou `/api?x` inconnus renvoient `index.html`       | Erreurs masquées côté client    | Tâche 1.5                         |
| Chemin des migrations via `import.meta.dirname`                              | Peut casser dans l'image Docker | À vérifier en 6.1                 |
| Paquet `cn` (shadcn) à la place de `clsx` + `tailwind-merge`                 | Dépendance peu répandue         | Acceptable ; à revoir si problème |
| Aucune intégration continue                                                  | Régressions non détectées en PR | Tâche 1.6                         |

## Prochaines actions

1. 1.5 Corrections API (404 JSON, type `data`).
2. 1.6 CI GitHub Actions.
3. 0.4 / 0.5, puis phase 2 (intégrations, assistant, connexion).
