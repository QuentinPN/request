# Ménage des worktrees et branches

## 2026-11-17

- Worktrees supprimés : aucun. Aucun worktree n'avait de branche déjà fusionnée ; les cinq restants portent des lots en cours (socle des intégrations, Emby, Radarr/Sonarr, TMDB, correctifs du socle).
- Branches locales supprimées (déjà contenues dans `main`, créées par les worktrees d'agents) : `worktree-agent-a146aeeae96d8d29f`, `worktree-agent-a45168016160c071f`, `worktree-agent-a60a7728788401bf1`, `worktree-agent-ae2fe699f86bdf776`, `worktree-agent-af58b1b9fc45e0192`, `worktree-agent-af89d952689ad5969`.
- Branches distantes : rien à supprimer, les branches des PR fusionnées (#1 à #4, #6) sont effacées à la fusion.

## 2026-11-17 (suite)

- Worktrees supprimés (branches fusionnées par #21 à #29) : `agent-ac66db16214b70b20`, `agent-a13eb2db3fd6eb30e`, `agent-a72761a3279bea9a3`, `agent-a8617d73ba3b51ff4`, `agent-a95f75a9cc32324ad`, `agent-ae7a13524580a6188`, `agent-af088779e6a657f89`, `agent-afb9c09444ababb00`, `agent-a0d2d340cb5ef3992`, `agent-a635c8ed7ff52c4a2` (dossier verrouillé par Windows, retiré de git par `git worktree prune`).
- Branches locales supprimées : `feat/demandes-api`, `feat/demandes-ui`, `feat/approbations-ui`, `feat/synchro`, `feat/demandes-api-v2`, `feat/emby-lien`, `feat/notifications`, `chore/docker`, `feat/discord`, `feat/import-seerr` et les `worktree-agent-*` associées.
- Branches distantes : effacées à la fusion des PR.
