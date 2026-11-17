# CLAUDE.md

Project setup from the `claude-boilerplate` repo. Add project-specific notes at the bottom.

## Orchestration

```
Opus 5.5 main session plans + signs off
├── .claude/agents/explorer.md → model: haiku  · Read, Grep, Glob
├── .claude/agents/coder.md    → model: sonnet (opus per call) · implements features
├── .claude/agents/fixer.md    → model: sonnet · Read, Edit, Bash
├── .claude/agents/checker.md  → model: sonnet · reviews every coder/fixer pass
└── .claude/settings.json      → PostToolUse hook runs tests after each edit
```

- The main session stays on Opus 5.5: **plan, delegate, read summaries only, sign off.**
- Search and reading → `explorer` (summary < 200 words).
- Implementation → `coder`, on a complete brief (files, rules, chosen design, definition of done). Sonnet by default; pass `model: "opus"` for heavy tasks. The configured advisor (`advisorModel`) carries over to subagents.
- Every `coder` or `fixer` pass → `checker`, with the brief (reviews it against its callers and the request) before sign-off.
- Localized `checker` finding → `fixer` (smallest patch). Design-level finding → resume the same `coder` with `SendMessage`. Two correction rounds at most, then the main session takes over and says so.
- **Parallel by default when independent** (pattern of superpowers `dispatching-parallel-agents`): before delegating, split the work into independent domains (research topics, modules with disjoint files, separate lots) and send all their `Agent` calls in the same message. Each parallel `coder` runs in its own worktree (`isolation: "worktree"`) on its own branch; never two agents editing the same files or sharing one working tree. Keep sequential what shares files, state or a not-yet-built foundation (build the shared base first, then fan out). One `checker` per lot, run in the background while the next work starts; after integration, a full `npm run verify`.
- Every subagent gets its own context window. The main session never reads raw output (logs, full files, diffs) when a subagent can summarize it.
- Never take a subagent's "done" on trust: check `git diff --stat` before signing off.

## Skills and plugins

This file, the project's own `.claude/skills/` and the agents above take precedence over generic plugins such as Superpowers.

- Delegation goes through `explorer` / `coder` / `checker` / `fixer`, not `subagent-driven-development`. The parallel pattern of `dispatching-parallel-agents` applies, with these agents (see Orchestration).
- Use the session's existing worktree and the Git rules below, not `using-git-worktrees` (no `.worktrees/` folder).
- `brainstorming` and `writing-plans` are fine, but specs and plans go in the PR or a scratch folder, never in a commit (no `docs/superpowers/`).
- A project skill that verifies or ships work (tests, PR, merge) replaces `verification-before-completion`, `finishing-a-development-branch` and `requesting-code-review`.
- `systematic-debugging`, `test-driven-development` and `receiving-code-review` apply as is.
- Database work: `database-architect` (`.claude/skills/`) before any new table, relation or migration (the `coder`/`checker` brief says to read it); `database-optimizer` when reviewing queries, indexes or a slow path. Both are generic: apply them to SQLite (WAL, `EXPLAIN QUERY PLAN`, partial and composite indexes, no server-side tuning). The data model lives in `docs/DATA_MODEL.md`.

## DRY (mandatory)

Code MUST be DRY. Do not duplicate definitions or logic. When the same constant, type, validation, or block of logic appears in more than one place, abstract it into a shared helper/utility and reuse it. Flag copy-pasted logic and repeated literals/definitions that should be centralized.

## Git

- Branches: before the first push, rename the harness branch (`claude/…`) with `git branch -m <type>/<short-kebab-description>`, `<type>` in `feat`, `fix`, `chore`, `refactor`, `docs`.
- Commits and PR titles: Conventional Commits, same `<type>` as the branch, optional scope (`feat(auth): add Discord login`). Short PR title and description.
- "full send" or "full auto": skill `full-send`, the task is taken end to end up to a merged PR into the integration branch, never the production branch.
- "semi auto": same skill, stopped at local commits: no push, no PR; the user reviews and ships.

## Slash commands

| Command            | Purpose                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `/state-machines`  | Document explicit/implicit state machines in `docs/STATE_MACHINES.md`, find reachable invalid states, fix with regression tests |
| `/dead-code`       | Separate branch: remove every `src/` function/file without a caller                                                             |
| `/dedupe`          | Separate branch: merge duplicated logic in `src/` into single functions                                                         |
| `/unused-deps`     | Separate branch: remove unused `package.json` dependencies one by one                                                           |
| `/clean-worktrees` | Remove worktrees whose branch is already merged, log them in `MENAGE.md`                                                        |

## Behavioral guidelines

Source: [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills/blob/main/CLAUDE.md)

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code. (Duplicated code is not single-use: see DRY above.)
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## Project-specific notes

**Request** : remplaçant personnel de Seerr (demandes de films et séries pour les membres d'Emby, envoi à Radarr/Sonarr). Lire [PRODUCT.md](PRODUCT.md), [ARCHITECTURE.md](ARCHITECTURE.md), [DESIGN.md](DESIGN.md), [ROADMAP.md](ROADMAP.md), puis [CURRENT_STATUS.md](CURRENT_STATUS.md) (état et prochaines actions) et [DECISIONS.md](DECISIONS.md) ; prompt de départ dans [PROMPT_CLAUDE.md](PROMPT_CLAUDE.md).

- L'utilisateur écrit en **français** : réponses, docs, textes d'interface en français.
- Stack : Node 26, Vite + React 19 + TS strict, TanStack Router/Query, shadcn/ui (Base UI) + Tailwind v4, Fastify 5, Zod partagé (`src/shared`), SQLite + Drizzle. Pas de SSR, pas de GraphQL, pas de Watt.
- Thème : tokens d'Hub, correspondance shadcn dans DESIGN.md (`--accent` shadcn ≠ accent de marque `--brand`).
- Interface : trois maquettes avant toute nouvelle page, captures 1440 et 390 px avant commit, raccourcis Windows uniquement.
- Le serveur fait autorité sur droits, quotas et statuts ; secrets chiffrés en base, jamais envoyés au client.
- Commandes (à créer en phase 1) : `npm run dev`, `npm run lint`, `npm run check`, `npm test`, `npm run verify`.
