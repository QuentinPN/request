# Contribuer

## Hooks git (hk)

Les hooks sont gérés par [hk](https://hk.jdx.dev) (`hk.pkl`). Une seule fois par poste : installer hk 2.13.0 (Windows : `hk.exe` de la [release GitHub](https://github.com/jdx/hk/releases/tag/v2.13.0), sinon `cargo install hk --version 2.13.0 --locked`), puis lancer `hk install` dans le clone. Facultatif : `git config hk.stashUntracked false` évite environ 1 s au pre-commit quand des fichiers non suivis traînent.

- `pre-commit` : Biome puis `bun fmt` sur les seuls fichiers indexés (corrige et réindexe ; une erreur restante bloque le commit), environ 0,3 s.
- `pre-push` : `bun run lint`, `format:check`, `check` et `test` sur tout le dépôt, comme la CI, environ 30 s.
