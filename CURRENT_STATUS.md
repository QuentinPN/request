# État actuel

Mis à jour à la fin de chaque session. Point d'entrée pour reprendre le travail.

## Où on en est (2026-11-18)

- **MVP et phase 7 fonctionnellement complets sur `dev`** : phases 0 à 5 et 7 faites ; la phase 6 attend le propriétaire et les vraies instances (voir « Prochaines actions »). La phase 7 (PR #38 à #47) a livré les 15 fonctions de « Plus tard », voir ROADMAP.md.
- **Dépôt** : `github.com/QuentinPN/Request` (privé). `main` = production (le MVP y a été fusionné, #31 puis #36 ; la phase 7 reste sur `dev` jusqu'à l'accord du propriétaire), `dev` = intégration ; une PR par lot, CI `npm run verify` + construction de l'image Docker.
- **Méthode** : lots indépendants en parallèle (un worktree par agent), `checker` sur chaque PR, correctifs avant fusion.

## Ce qui existe réellement

- **Serveur** : Fastify, garde de session globale sur `/api/*` (cookie httpOnly, CSRF par en-tête + origine, proxy de confiance limité à la boucle locale ou `TRUST_PROXY`), erreurs uniformes `{ error }`. Seules exceptions publiques : `/api/health` et les deux webhooks *arr (jeton).
- **Serveur multimédia au choix** (Emby, Jellyfin ou Plex, un seul actif, type figé dès qu'un membre existe) : connexion par compte du serveur (Plex : code PIN plex.tv), premier administrateur = propriétaire, rôles et quotas par membre (propriétaire et gestionnaires exemptés), import des membres.
- **Assistant** et Réglages : serveur multimédia (bibliothèques, adresse publique), TMDB, liste de serveurs Radarr et Sonarr (dont 4K, profils, dossiers), règles et quotas, masquage dans Découvrir, Blocages, Webhooks (adresses, jeton régénérable), Notifications (Discord, courriel SMTP), Trakt, API (clés), import Seerr ; secrets chiffrés, jamais renvoyés.
- **Catalogue** : Découvrir, Films/Séries par genre, fiche complète, recherche `Ctrl+K`, images relayées avec cache disque borné.
- **Statuts** calculés côté serveur (disponible, partiel, en téléchargement, 4K à part), épisodes présents/attendus par saison, lien « Regarder dans » le serveur choisi.
- **Demandes** : feuille de demande (film, saisons, 4K, pour un autre membre, hors quota), Mes demandes, bande « Vos demandes en cours », frise ; Approbations (tableau + panneau, cartes sur mobile) avec choix du serveur, du profil et du dossier, refus motivé, relance des échecs ; envoi à Radarr/Sonarr ; blocage de titres et de mots-clés.
- **Autour des demandes** : signalements avec commentaires, liste de souhaits « Ma liste » avec import Trakt et Letterboxd, statistiques, clés d'API (`X-Api-Key`, docs/API.md).
- **Synchronisation** : webhooks Radarr/Sonarr (par serveur), balayage léger (10 min) et complet (24 h, purges), passage automatique des demandes à « disponible ».
- **Notifications** : cloche, Discord, courriel et push web (distribution unique après validation) ; application installable (PWA).
- **Navigation** : pilule avec menu « Plus » (ordinateur), cinq onglets au plus (mobile).
- **Production** : Dockerfile, `compose.yml` durci + Caddy, sauvegarde quotidienne de la base, guide [docs/DEPLOIEMENT.md](docs/DEPLOIEMENT.md).
- **Base** : SQLite (WAL), migrations 0000 à 0010, modèle dans `docs/DATA_MODEL.md`.
- **Tests** : 691 unitaires et de routes (faux serveurs Emby, Jellyfin, Plex, Radarr, Sonarr, TMDB, Trakt, Discord, SMTP, push, Seerr), 392 e2e Playwright (1440 et 390 px) avec axe.

## Risques et points de vigilance

| Risque                                                                                                                                                                                                                | Impact                                                              | Traitement                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 4 points des API restants à confirmer (docs/integrations.md ; versions vérifiées : Emby 4.10.2.0, Radarr 7.0.3, Sonarr 4.0.20, Seerr 3.5.2)                                                                           | Statuts, liens ou import faux en production                         | Essai sur l'instance réelle avant 6.3                                                                         |
| Routes Emby passées à `/Users/Query` et `/Library/VirtualFolders/Query` avec l'en-tête d'authentification `Emby`, d'après la référence 4.10, pas encore testées en réel                                               | Connexion ou liste des bibliothèques en échec                       | Le bouton « Tester » de l'assistant le révèle aussitôt ; retour possible aux routes qu'utilise Seerr          |
| Jellyfin et Plex jamais essayés sur une instance réelle : points [?] de `docs/integrations.md` (id du serveur, lien web, « Ajoutés récemment », membres de Plex Home, `leafCount`, format de `expiresAt` du code PIN) | Connexion, statuts ou liens faux si l'un d'eux remplace Emby        | Les vérifier le jour du changement ; le bouton « Tester » de l'assistant révèle les erreurs de connexion      |
| Séparateur `\|` de `without_keywords` (mots-clés bloqués dans Découvrir) non vérifié sur le vrai TMDB                                                                                                                 | Rangées Découvrir non filtrées par mot-clé                          | La fiche et le refus de la demande bloquent quand même ; essai avec un mot-clé réel                           |
| Push web : HTTPS obligatoire (navigateurs) et `PUBLIC_URL` (lien des courriels, contact VAPID) ; sur iPhone et iPad, appli ajoutée à l'écran d'accueil                                                                | Pas de push sans HTTPS ; courriels sans lien si `PUBLIC_URL` manque | Caddy fournit HTTPS ; `compose.yml` fixe `PUBLIC_URL=https://${DOMAIN}` ; à renseigner à la main hors Compose |
| Clé d'API volée (agit comme le propriétaire)                                                                                                                                                                          | Accès complet jusqu'à la révocation                                 | Clé montrée une seule fois, hachée, limite des échecs ; la révoquer dans Réglages › API                       |
| Radarr/Sonarr doivent joindre l'adresse des webhooks depuis leur conteneur                                                                                                                                            | Statuts mis à jour seulement par les balayages                      | Vérifier au déploiement ; le balayage de 10 min sert de filet                                                 |
| Amorçage (avant propriétaire) : prise de contrôle par un tiers ou par rebinding DNS                                                                                                                                   | Prise de contrôle pendant l'installation                            | Jeton d'installation exigé (journaux du conteneur ou `SETUP_TOKEN`), limite des échecs par IP                 |
| Clé de chiffrement `/data/secret.key`                                                                                                                                                                                 | Sauvegarde inutilisable sans elle                                   | Documenté dans DEPLOIEMENT.md ; la sauvegarder à part                                                         |
| Restauration de sauvegarde jamais exercée                                                                                                                                                                             | Perte de données en cas d'incident                                  | À tester lors du déploiement (6.3)                                                                            |

## Prochaines actions (côté propriétaire)

1. ~~**Logo (3.4)**~~ : fait (R-loupe intégré).
2. **Points restants (0.5)** : confirmer sur l'instance réelle les 4 points de `docs/integrations.md`.
3. ~~**Fusion `dev` → `main`**~~ : faite (#31).
4. **Fusion de la phase 7 (`dev` → `main`)** : relire les captures `docs/captures/7.x`, puis donner l'accord de fusion.
5. **Déploiement (6.3)** : sur le mini-PC à côté de Seerr, avec votre accord ; parcourir l'assistant, tester la restauration, essai avec de vrais membres, puis arrêt de Seerr.
6. **Réglages à faire une fois déployé** : serveur 4K éventuel, SMTP, Client ID Trakt (facultatifs) ; `PUBLIC_URL` hors Compose ; garder Emby, ou vérifier Jellyfin ou Plex sur une instance avant de changer.
