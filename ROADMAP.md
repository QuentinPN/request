# Roadmap avec portes de validation

Chaque jalon se termine par une démonstration (captures 1440 et 390 px pour l'interface), des tests verts et mon accord avant le suivant.

## Phase 0 — Cadrage et design (STOP obligatoire)

[ ] Lire le README et la documentation de Seerr ; confirmer ou ajuster la liste MVP / plus tard de PRODUCT.md
[ ] Vérifier les API réelles : Emby (authentification, recherche par id TMDB, webhooks), Radarr et Sonarr v3 (ajout, file, webhooks), TMDB ; noter les versions installées sur le mini-PC sans rien modifier
[ ] Confirmer la variante Base UI de shadcn et les versions des dépendances
[ ] Trois directions de design (ordinateur 1440 px, mobile 390 px) : Découvrir, fiche titre et feuille de demande, Mes demandes, Approbations, assistant ; états chargement, vide, erreur ; comparatif et recommandation
[ ] Validation explicite d'une direction

## Phase 1 — Socle

[x] Initialisation : Vite + React + TS strict, Fastify, Biome, Vitest, Playwright, `npm run verify` (lint, types, tests, build) → vérif : la commande passe à vide
[x] Tokens d'Hub, correspondance shadcn, composants de base (bouton, carte, affiche, pastille de statut, dialogue, squelette) → vérif : page de démonstration des composants, captures
[x] SQLite + Drizzle, migrations, chiffrement des secrets, réglages typés Zod → vérif : tests de migration et de lecture/écriture chiffrée
[ ] Shell : navigation pilule et barre mobile, routes, `Ctrl+K`, états globaux → vérif : Playwright clavier + axe

## Phase 2 — Configuration et connexion

[ ] Assistant : Emby, Radarr, Sonarr, TMDB, chaque étape testée en direct → vérif : tests contre de faux serveurs, cas d'erreur lisibles
[ ] Connexion par compte Emby, sessions, premier admin propriétaire, import des membres → vérif : tests de route, cookie httpOnly, origine refusée
[ ] Réglages modifiables après coup (mêmes formulaires que l'assistant, aucun doublon)

## Phase 3 — Découvrir et fiches

[ ] Client TMDB avec cache, rangées Découvrir, recherche, fiche film et série → vérif : fixtures TMDB, captures
[ ] Statut de disponibilité calculé côté serveur (Emby + Radarr/Sonarr) et affiché sur chaque affiche → vérif : tests par cas (absent, partiel, disponible, en téléchargement)

## Phase 4 — Demandes

[ ] Création (film, saisons), droits, approbation automatique, quotas → vérif : tests transactionnels, double clic idempotent
[ ] File d'approbation, modification avant envoi, refus avec motif, envoi à Radarr/Sonarr → vérif : faux Radarr/Sonarr, échec d'envoi visible et rejouable
[ ] Mes demandes / Toutes les demandes, annulation

## Phase 5 — Synchronisation et notifications

[ ] Webhooks Radarr/Sonarr entrants (jeton), balayage Emby léger et complet planifié, progression de téléchargement → vérif : tests de transition de statut
[ ] Notifications dans l'appli (créée, approuvée, refusée, disponible) → vérif : tests du contenu des messages
[ ] Facultatif : webhook Discord dans Réglages › Notifications, désactivé par défaut → vérif : aucun appel sans webhook

## Phase 6 — Mise en production

[ ] Dockerfile `linux/amd64`, `compose.yml` durci, Caddy, healthcheck, sauvegarde du dossier `/data` → vérif : image démarrée en local, assistant parcouru de bout en bout
[ ] Import facultatif des demandes de Seerr
[ ] Déploiement sur le mini-PC à côté de Seerr, essai avec de vrais membres, puis arrêt de Seerr (avec mon accord)

## Après le MVP

Voir « Plus tard » dans PRODUCT.md, à prioriser après quelques semaines d'usage réel.
