#!/usr/bin/env bash
# Job `tests-changed` de la CI : les tests que le diff de la PR peut atteindre, via `bun run test:bun --changed=<merge-base>`
# (graphe d'imports de Bun). Tout fichier que ce graphe ne voit pas relance la suite complète : la liste ci-dessous
# (dépendances, configs, aides de test, workflows), et tout ce qui n'est pas un module TS de src/ ou un fichier de test
# (fixtures, migrations SQL, package.json lu par build-info, docs/openapi.json, public/… sont lus par fs, pas importés).
# Suppressions et renommages aussi : le graphe ne suit pas un fichier qui n'existe plus.
# Usage : scripts/ci-changed-tests.sh <branche de base>, par exemple origin/dev.
set -euo pipefail

base=$(git merge-base "$1" HEAD)
reason=""
while IFS=$'\t' read -r status path _; do
  case "$status" in
    D* | R* | C*) reason="$path (supprimé, renommé ou copié)" ;;
    *)
      case "$path" in
        package.json | bun.lock | bunfig.toml | tsconfig.json | vite.config.ts | biome.json | .nvmrc | drizzle.config.ts | \
          test/helpers.ts | test/fake-server.ts | test/fake-tags.ts | test/vitest-compat.ts | test/fixtures/* | \
          .gitea/workflows/* | scripts/ci-changed-tests.sh)
          reason="$path (entrée de toute la suite)" ;;
        src/*.ts | src/*.tsx | test/*.test.ts) ;;
        *) reason="$path (hors du graphe d'imports)" ;;
      esac
      ;;
  esac
  [ -n "$reason" ] && break
done < <(git diff --name-status "$base" HEAD)

echo "Base : $1 ($base)"
git diff --name-status "$base" HEAD
if [ -n "$reason" ]; then
  echo "Suite complète : $reason"
  exec bun run test:bun
fi
echo "Tests atteints par le diff seulement (bun test --changed)"
exec bun run test:bun --changed="$base"
