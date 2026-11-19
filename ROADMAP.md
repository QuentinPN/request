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

## Phase 8 — Parité avec Seerr

Audit du 2026-11-18 fait sur le code de Seerr (branche `develop` : `server/lib/permissions.ts`, `src/components/Settings/*`, agents de notification) et vérifié dans `src/`. Hors périmètre, par décision : connexion locale, plusieurs serveurs multimédias, réglages réseau (proxy, DNS), langue d'interface autre que le français. Ce qui dépasse déjà Seerr : cloche, sauvegarde, statistiques, désactivation des membres retirés du serveur.

- [x] **8.0** (P0) Navigation et membres : bouton « Retour » partagé, onglet parent actif ; correction de la demande de nouvelles saisons d'une série déjà demandée ; édition du rôle et du quota d'un membre (approbation auto, gestionnaire, quota propre ou illimité) ; demandes d'un membre visibles par les gestionnaires (`/demandes?membre=`)
- [x] **8.1** (P1) Réglages › Général et À propos : titre de l'appli modifiable (onglet, courriels, messages d'essai ; réglage JSON, pas de migration), version, commit (`GIT_SHA`), Node, durée de marche, fuseau, dossier et taille de la base, compteurs de membres, titres suivis et demandes par statut ; vérification de mise à jour écartée (dépôt privé) → tests de routes
- [x] **8.2** (P1) Réglages › Tâches, cache et journaux (propriétaire) : balayages et sauvegarde avec dernière et prochaine exécution, « Lancer maintenant » (202, 409 si déjà en cours), fréquence des balayages réglable sans redémarrage (JSON `jobs`, sans migration) ; poids et vidage du cache d'images ; 1 000 derniers journaux filtrables (niveau, texte), secrets expurgés (`src/server/lib/log-buffer.ts`)
- [x] **8.3** (P1) Envoi à Radarr/Sonarr : les tags du serveur sont stockés mais jamais envoyés (à corriger) ; option « taguer avec le nom du membre » ; « rechercher à l'ajout » réglable (aujourd'hui toujours activé) ; adresse externe du serveur (lien vers Radarr/Sonarr) ; profil et dossier anime à part — fait : étiquettes du serveur envoyées (film, série, saisons ajoutées à une série existante sans perdre les siennes) ; option « Taguer avec le nom du membre » (`<id>-<nom>`, format de Seerr, créée une fois puis reprise) ; « Rechercher à l'ajout » par serveur ; adresse externe (lien « Ouvrir dans… » en Réglages et à l'approbation) ; réglages anime Sonarr (profil, dossier, type, langue, étiquettes ; mot-clé TMDB 210024 comme Seerr) ; sélecteur d'étiquettes dans le formulaire ; migration `0012_envoi_arr`
- [x] **8.4** (P2) Permissions fines : les quatre rôles restent des préréglages, 15 droits réglables par membre (`users.permissions`, écart au rôle, migration `0013_droits_fins` sans réécriture) ; demander film / série / 4K et approbation auto film / série / 4K vérifiés par le serveur (403) et reflétés dans « Demander » ; « Gérer les membres » ouvert aux non-propriétaires avec garde contre l'escalade ; droits par défaut des nouveaux membres ; édition en masse en une transaction ; section « Avancé » du dialogue du membre
- [x] **8.5** (P2) Notifications : agents ntfy, Telegram et webhook sortant (JSON documenté dans [docs/API.md](docs/API.md)) sur une plomberie commune avec Discord (`services/agents.ts`, `routes/agents.ts`, `agent-form.tsx`), évènement `auto_approved` pour les agents, types cochés du courriel (`smtp.events`) → tests de routes et de distribution avec faux serveurs ; reste : `auto_approved` dans la cloche et choix des types par membre (migration), Gotify, Pushover, Slack
- [x] **8.6** (P2) Catalogue : partie A (pages `/personne/:id` avec filmographie Films/Séries et filtre Acteur/Équipe, `/collection/:id` « Demander les films manquants », carte « Fait partie de la saga », rangée « Équipe » de la fiche) et partie B (filtres Films/Séries, rangées studio, chaîne et « Demandes récentes »)
  - Partie B livrée (branche `feat/filtres-rangees`) : filtres Films/Séries (genres multiples, année, note, durée, langue, plateforme, tri, studio, chaîne) dans l'adresse, barre/feuille, pastilles et « Réinitialiser » ; rangées « Demandes récentes », « Par studio », « Par chaîne » → tests de routes et e2e axe ; captures `docs/captures/8.6b`
- [x] **8.7** (P3) Découvrir personnalisable (ordre, masquage, rangées sur mesure), région et langue TMDB réglables au lieu de `fr-FR` codé en dur, région de streaming → Réglages › Découvrir (boutons monter/descendre, rangées sur mesure = type + filtres de Films/Séries, « Tout voir »), réglages `discoverLayout` et `tmdbLocale` sans migration ; tests de routes (validation, ordre, rangées sur mesure, langue et région dans les requêtes TMDB et la clé du cache)
- [x] **8.8** (P3) Membres : suppression d'un membre (une transaction, cascades ; refusée pour le propriétaire et soi-même) ; demande avancée par le membre (droit « Demande avancée » : serveur, profil, dossier, type de série, validés contre le serveur) ; modification d'une demande en attente (saisons et choix d'envoi, 409 si approuvée entre-temps) ; règles de surcharge (Seerr `OverrideRule` : genres, langues originales, mots-clés TMDB → serveur, profil, dossier, type de série, étiquettes ; ordre réglable, Réglages › Règles de surcharge, « Règle appliquée » à l'approbation ; migration `0015_regles_de_surcharge`)
- [x] **8.9** (P3, à valider) Demande automatique depuis « Ma liste », vote sur les demandes : demande automatique faite ; vote non fait (nouvelle mécanique produit, à valider) → option du membre en tête de Ma liste (droit `canAutoRequestWatchlist`), l'ajout manuel demande aussi le titre (film, ou saisons diffusées encore à demander), refus sans effet sur l'ajout (motif dans la réponse), sans migration ; tests de routes (droit, film, série, droit retiré, quota, déjà demandé ou disponible, approbation automatique)
- [x] **8.10** Notifications : types choisis par membre, « approuvée automatiquement » dans la cloche, le courriel et le push

Parallélisme : 8.1, 8.2, 8.3, 8.5 et 8.6 touchent des fichiers disjoints et peuvent partir ensemble ; 8.4 seul, puis 8.8 et 8.9 qui en dépendent ; 8.7 après 8.6.

## Après le MVP

La phase 7 a livré toutes les fonctions de « Plus tard » (PRODUCT.md, « Fonctions après le MVP »). Il ne reste que ce qui dépend du propriétaire et des instances réelles : voir CURRENT_STATUS.md.
