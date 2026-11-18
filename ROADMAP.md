# Roadmap avec portes de validation

Chaque jalon se termine par une démonstration (captures 1440 et 390 px pour l'interface) et des tests verts. Chaque lot part de `dev` sur sa propre branche, passe en PR vers `dev`, puis est fusionné. `main` reste la branche de production (fusion de `dev` avec l'accord du propriétaire).

Priorités : **P0** bloquant, **P1** élevée, **P2** normale, **P3** confort. Statuts : `[x]` fait et validé, `[~]` en cours, `[ ]` à faire.

## Phase 0 — Cadrage et design

- [x] **0.1** (P0) Trois directions de design, comparatif, recommandation → [canevas des maquettes](https://claude.ai/artifact/UVig26hmQYFHEsaaqDoL3H)
- [x] **0.2** (P0) Validation d'une direction : page « Recommandation » du canevas (détail dans DESIGN.md, « Direction validée »)
- [x] **0.3** (P1) Variante Base UI de shadcn confirmée (`@base-ui/react` installé, composants de base en place)
- [x] **0.4** (P0, avant la phase 2) Lire le README de Seerr ; confirmer ou ajuster la liste MVP / plus tard de PRODUCT.md
- [x] **0.5** (P0, avant la phase 2) API réelles : Emby (authentification, recherche par id TMDB, webhooks), Radarr et Sonarr v3 (ajout, file, webhooks), TMDB ; versions installées sur le mini-PC à fournir par le propriétaire, sans rien modifier. Versions vérifiées (Emby 4.10.2.0, Radarr 7.0.3, Sonarr 4.0.20, Seerr 3.5.2) ; 4 points restants à confirmer sur l'instance réelle, listés dans [docs/integrations.md](docs/integrations.md)

## Phase 1 — Socle

- [x] **1.1** (P0) Vite + React + TS strict, Fastify, Biome, Vitest, Playwright, `npm run verify` → la commande passe
- [x] **1.2** (P0) Tokens d'Hub, correspondance shadcn, composants de base → page de démonstration, captures `docs/captures/1.2`
- [x] **1.3** (P0) SQLite + Drizzle, migrations, chiffrement des secrets, réglages typés Zod → tests de migration et de lecture/écriture chiffrée
- [x] **1.4** (P0) Shell : navigation pilule (ordinateur) et barre d'onglets flottante (mobile), routes TanStack Router à chargement différé, `Ctrl+K`, états globaux (chargement, vide, erreur « Réessayer »)
  - Critères : navigation au clavier complète, `Ctrl+K` ouvre la recherche, `Échap` la ferme ; aucune violation axe à 1440 et 390 px ; captures `docs/captures/1.4`
  - Validation : Playwright clavier + axe, `npm run verify`
- [x] **1.5** (P1) API : `FastifyInstance.data` typé honnêtement ; tout chemin `/api` inconnu (y compris `/api` et `/api?x`) renvoie un 404 JSON, avec ou sans client compilé → test de route
- [x] **1.6** (P1) Intégration continue GitHub Actions (`npm run verify`) sur les PR vers `dev` et `main`
- [x] **1.7** (P1) Base : index `sessions(user_id)` et `sessions(expires_at)`, `CHECK` sur `users.role`, lecture validée de `quota_override`, PRAGMA `synchronous=NORMAL` et `journal_size_limit` (cf. docs/DATA_MODEL.md) → tests de migration, `EXPLAIN QUERY PLAN` sur la purge

## Phase 2 — Configuration et connexion

- [x] **2.1** (P0) Modules d'intégration Emby, Radarr, Sonarr, TMDB (délai, nouvelles tentatives limitées, erreurs lisibles) → tests contre de faux serveurs
- [x] **2.2** (P0) Assistant (une page, sections testées en direct, cf. maquette R-Assistant) → cas d'erreur lisibles
- [x] **2.3** (P0) Connexion par compte Emby, sessions, premier admin propriétaire, import des membres → tests de route, cookie httpOnly, origine refusée
- [x] **2.4** (P1) Réglages modifiables après coup (mêmes formulaires que l'assistant, aucun doublon)

## Phase 3 — Découvrir et fiches

- [x] **3.1** (P0) Client TMDB avec cache, rangées Découvrir, recherche, fiche film et série → fixtures TMDB, captures
- [x] **3.2** (P0) Statut de disponibilité calculé côté serveur (Emby + Radarr/Sonarr) et affiché sur chaque affiche → tests par cas (absent, partiel, disponible, en téléchargement)
- [x] **3.3** (P1) Lien « Regarder dans Emby » (adresse publique d'Emby dans les réglages) et nombre d'épisodes présents par saison dans le contrat → affiches et fiche
- [x] **3.4** (P1) Logo et favicon : choix du propriétaire entre les finalistes de `docs/logo/round2/final`, puis intégration (en-tête, favicon, icônes) — R-loupe, voir DESIGN.md « Logo »

## Phase 4 — Demandes

- [x] **4.1** (P0) Création (film, saisons), droits, approbation automatique, quotas → tests transactionnels, double clic idempotent
- [x] **4.2** (P0) Approbations (tableau + panneau sur ordinateur, carte par carte sur mobile), modification avant envoi, refus avec motif, envoi à Radarr/Sonarr → faux Radarr/Sonarr, échec visible et rejouable
- [x] **4.3** (P1) Mes demandes / Toutes les demandes, annulation, bande « Vos demandes en cours » et frise de suivi

## Phase 5 — Synchronisation et notifications

- [x] **5.1** (P0) Webhooks Radarr/Sonarr entrants (jeton), balayage Emby léger et complet planifié, progression de téléchargement → tests de transition de statut
- [x] **5.2** (P1) Notifications dans l'appli (créée, approuvée, refusée, disponible) → tests du contenu des messages
- [x] **5.3** (P2) Facultatif : webhook Discord dans Réglages › Notifications, désactivé par défaut → aucun appel sans webhook

## Phase 6 — Mise en production

- [~] **6.1** (P0) Dockerfile `linux/amd64`, `compose.yml` durci, Caddy, healthcheck, sauvegarde de `/data` → image démarrée en local, assistant parcouru de bout en bout. Fait : image construite et lancée (lecture seule, `healthy`), compose + Caddy en HTTPS, sauvegarde, cache d'images borné, [docs/DEPLOIEMENT.md](docs/DEPLOIEMENT.md). Reste : assistant parcouru de bout en bout et restauration exercée, avec les vraies instances
- [x] **6.2** (P2) Import facultatif des demandes de Seerr (Réglages › Importer depuis Seerr : aperçu, puis import idempotent)
- [ ] **6.3** (P0) Déploiement sur le mini-PC à côté de Seerr, essai avec de vrais membres, puis arrêt de Seerr (avec l'accord du propriétaire)

## Phase 7 — Fonctions après le MVP

Fonctions de « Plus tard » (PRODUCT.md), livrées en une PR par lot vers `dev`. Choix du propriétaire du 2026-11-17 : pas de maquettes, les nouvelles pages dérivent de la direction validée (captures 1440 et 390 px à la place) ; un seul serveur multimédia au choix ; 4K pris en charge.

- [x] **7.1** (P0) Socle : migration `0010_phase7.sql` (serveurs Radarr/Sonarr, saisons 4K, signalements, liste de souhaits, abonnements push, blocages, clés d'API), types Zod et droits partagés, réglages → tests de migration sur base existante, contraintes et index (PR #38)
- [x] **7.2** (P1) Plusieurs Radarr/Sonarr et demandes 4K : liste de serveurs dans l'assistant et les Réglages, serveur choisi à l'approbation, statut 4K à part, webhooks par serveur → faux serveurs, e2e ; captures `docs/captures/7.2` (PR #43)
- [x] **7.3** (P1) Serveur multimédia au choix, Emby, Jellyfin ou Plex (un seul actif) : connexion, membres, disponibilité, « Ajoutés récemment », lien, code PIN plex.tv → faux serveurs de chaque type ; captures `docs/captures/7.3` (PR #46)
- [x] **7.4** (P1) Signalements de problèmes : depuis la fiche d'un titre disponible, page « Signalements », fil de commentaires, résolution et réouverture, notifications → tests de droits et de notifications ; captures `docs/captures/7.4` (PR #42)
- [x] **7.5** (P2) Liste de souhaits « Ma liste », import Trakt (Client ID dans les Réglages) et Letterboxd (`watchlist.csv`) : aperçu puis import idempotent → faux Trakt et TMDB ; captures `docs/captures/7.5` (PR #41)
- [x] **7.6** (P2) Notifications par courriel (SMTP) et push web, application installable (PWA) : un seul service de distribution après validation, aucun cache d'API → faux SMTP et push, e2e ; captures `docs/captures/7.6` (PR #44)
- [x] **7.7** (P2) Page « Statistiques » (gestionnaires et propriétaire, `canViewStats`) : totaux, demandes par mois, membres et titres les plus actifs, délais moyens, calculés en SQL par un seul endpoint → tests de calcul ; captures `docs/captures/7.7` (PR #39)
- [x] **7.8** (P3) Clé d'API publique : clés nommées montrées une seule fois et hachées, `X-Api-Key` qui agit comme le propriétaire créateur, limite des échecs, [docs/API.md](docs/API.md) → tests d'authentification ; captures `docs/captures/7.8` (PR #40)
- [x] **7.9** (P2) Ajustements des demandes : demander pour un membre, hors quota, blocage de titres et de mots-clés TMDB, masquage dans Découvrir des titres disponibles ou déjà demandés → tests de droits et de quotas ; captures `docs/captures/7.9` (PR #45)
- [x] **7.10** (P2) Navigation allégée : menu « Plus » sur la pilule, cinq onglets au plus sur mobile, cloche dans l'en-tête → e2e axe ; captures `docs/captures/7.10` (PR #47)

## Après le MVP

La phase 7 a livré toutes les fonctions de « Plus tard » (PRODUCT.md, « Fonctions après le MVP »). Il ne reste que ce qui dépend du propriétaire et des instances réelles : voir CURRENT_STATUS.md.
