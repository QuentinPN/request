# CLAUDE.md

**Request** : remplaçant personnel de Seerr (demandes de films et séries pour les membres d'Emby, envoi à Radarr/Sonarr). Lire [PRODUCT.md](PRODUCT.md), [ARCHITECTURE.md](ARCHITECTURE.md), [DESIGN.md](DESIGN.md), [ROADMAP.md](ROADMAP.md), puis [CURRENT_STATUS.md](CURRENT_STATUS.md) (état et prochaines actions) et [DECISIONS.md](DECISIONS.md) ; prompt de départ dans [PROMPT_CLAUDE.md](PROMPT_CLAUDE.md).

- L'utilisateur écrit en **français** : réponses, docs, textes d'interface en français.
- Stack : Node 26, Vite + React 19 + TS strict, TanStack Router/Query, shadcn/ui (Base UI) + Tailwind v4, Fastify 5, Zod partagé (`src/shared`), SQLite + Drizzle. Pas de SSR, pas de GraphQL, pas de Watt.
- Thème : tokens d'Hub, correspondance shadcn dans DESIGN.md (`--accent` shadcn ≠ accent de marque `--brand`).
- Interface : trois maquettes avant toute nouvelle page, contrôle visuel à 1440 et 390 px avant commit (captures dans `docs/captures/` seulement pour une nouvelle page, une refonte ou sur demande), raccourcis Windows uniquement.
- Le serveur fait autorité sur droits, quotas et statuts ; secrets chiffrés en base, jamais envoyés au client.
- Commandes (à créer en phase 1) : `bun install`, `bun run dev`, `bun run lint`, `bun run check`, `bun run test` (Vitest sous Node 26, la suite de référence ; `bun run test:bun` lance la même suite sous bun test, plus rapide), `bun run verify` (Bun installe et lance les scripts ; l’appli tourne sous Node 26).
