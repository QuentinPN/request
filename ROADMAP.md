# Roadmap avec portes de validation

Chaque jalon se termine par une démonstration (captures 1440 et 390 px pour l'interface) et des tests verts. Chaque lot part de `dev` sur sa propre branche, passe en PR vers `dev`, puis est fusionné. `main` reste la branche de production (fusion de `dev` avec l'accord du propriétaire).

Priorités : **P0** bloquant, **P1** élevée, **P2** normale, **P3** confort. Statuts : `[x]` fait et validé, `[~]` en cours, `[ ]` à faire.

## Phase 0 — Cadrage et design

- [x] **0.1** (P0) Trois directions de design, comparatif, recommandation → [canevas des maquettes](https://claude.ai/artifact/UVig26hmQYFHEsaaqDoL3H)
- [x] **0.2** (P0) Validation d'une direction : page « Recommandation » du canevas (détail dans DESIGN.md, « Direction validée »)
- [x] **0.3** (P1) Variante Base UI de shadcn confirmée (`@base-ui/react` installé, composants de base en place)
- [ ] **0.4** (P0, avant la phase 2) Lire le README de Seerr ; confirmer ou ajuster la liste MVP / plus tard de PRODUCT.md
- [ ] **0.5** (P0, avant la phase 2) API réelles : Emby (authentification, recherche par id TMDB, webhooks), Radarr et Sonarr v3 (ajout, file, webhooks), TMDB ; versions installées sur le mini-PC à fournir par le propriétaire, sans rien modifier

## Phase 1 — Socle

- [x] **1.1** (P0) Vite + React + TS strict, Fastify, Biome, Vitest, Playwright, `npm run verify` → la commande passe
- [x] **1.2** (P0) Tokens d'Hub, correspondance shadcn, composants de base → page de démonstration, captures `docs/captures/1.2`
- [x] **1.3** (P0) SQLite + Drizzle, migrations, chiffrement des secrets, réglages typés Zod → tests de migration et de lecture/écriture chiffrée
- [x] **1.4** (P0) Shell : navigation pilule (ordinateur) et barre d'onglets flottante (mobile), routes TanStack Router à chargement différé, `Ctrl+K`, états globaux (chargement, vide, erreur « Réessayer »)
  - Critères : navigation au clavier complète, `Ctrl+K` ouvre la recherche, `Échap` la ferme ; aucune violation axe à 1440 et 390 px ; captures `docs/captures/1.4`
  - Validation : Playwright clavier + axe, `npm run verify`
- [ ] **1.5** (P1) API : `FastifyInstance.data` typé honnêtement ; tout chemin `/api` inconnu (y compris `/api` et `/api?x`) renvoie un 404 JSON, avec ou sans client compilé → test de route
- [ ] **1.6** (P1) Intégration continue GitHub Actions (`npm run verify`) sur les PR vers `dev` et `main`

## Phase 2 — Configuration et connexion

- [ ] **2.1** (P0) Modules d'intégration Emby, Radarr, Sonarr, TMDB (délai, nouvelles tentatives limitées, erreurs lisibles) → tests contre de faux serveurs
- [ ] **2.2** (P0) Assistant (une page, sections testées en direct, cf. maquette R-Assistant) → cas d'erreur lisibles
- [ ] **2.3** (P0) Connexion par compte Emby, sessions, premier admin propriétaire, import des membres → tests de route, cookie httpOnly, origine refusée
- [ ] **2.4** (P1) Réglages modifiables après coup (mêmes formulaires que l'assistant, aucun doublon)

## Phase 3 — Découvrir et fiches

- [ ] **3.1** (P0) Client TMDB avec cache, rangées Découvrir, recherche, fiche film et série → fixtures TMDB, captures
- [ ] **3.2** (P0) Statut de disponibilité calculé côté serveur (Emby + Radarr/Sonarr) et affiché sur chaque affiche → tests par cas (absent, partiel, disponible, en téléchargement)

## Phase 4 — Demandes

- [ ] **4.1** (P0) Création (film, saisons), droits, approbation automatique, quotas → tests transactionnels, double clic idempotent
- [ ] **4.2** (P0) Approbations (tableau + panneau sur ordinateur, carte par carte sur mobile), modification avant envoi, refus avec motif, envoi à Radarr/Sonarr → faux Radarr/Sonarr, échec visible et rejouable
- [ ] **4.3** (P1) Mes demandes / Toutes les demandes, annulation, bande « Vos demandes en cours » et frise de suivi

## Phase 5 — Synchronisation et notifications

- [ ] **5.1** (P0) Webhooks Radarr/Sonarr entrants (jeton), balayage Emby léger et complet planifié, progression de téléchargement → tests de transition de statut
- [ ] **5.2** (P1) Notifications dans l'appli (créée, approuvée, refusée, disponible) → tests du contenu des messages
- [ ] **5.3** (P2) Facultatif : webhook Discord dans Réglages › Notifications, désactivé par défaut → aucun appel sans webhook

## Phase 6 — Mise en production

- [ ] **6.1** (P0) Dockerfile `linux/amd64`, `compose.yml` durci, Caddy, healthcheck, sauvegarde de `/data` → image démarrée en local, assistant parcouru de bout en bout
- [ ] **6.2** (P2) Import facultatif des demandes de Seerr
- [ ] **6.3** (P0) Déploiement sur le mini-PC à côté de Seerr, essai avec de vrais membres, puis arrêt de Seerr (avec l'accord du propriétaire)

## Après le MVP

Voir « Plus tard » dans PRODUCT.md, à prioriser après quelques semaines d'usage réel.
