# État actuel

Mis à jour à la fin de chaque session. Point d'entrée pour reprendre le travail.

## Où on en est (2026-11-17)

- **MVP fonctionnellement complet sur `dev`** : phases 0 à 6 faites, sauf ce qui dépend du propriétaire ou des vraies instances (voir « Prochaines actions »).
- **Dépôt** : `github.com/QuentinPN/Request` (privé). `main` = production (rien n'y a encore été fusionné), `dev` = intégration ; une PR par lot (#1 à #29), CI `npm run verify` + construction de l'image Docker.
- **Méthode** : lots indépendants en parallèle (un worktree par agent), `checker` sur chaque PR, correctifs avant fusion.

## Ce qui existe réellement

- **Serveur** : Fastify, garde de session globale sur `/api/*` (cookie httpOnly, CSRF par en-tête + origine, proxy de confiance limité à la boucle locale ou `TRUST_PROXY`), erreurs uniformes `{ error }`. Seules exceptions publiques : `/api/health` et les deux webhooks *arr (jeton).
- **Connexion** par compte Emby, premier admin Emby = propriétaire, rôles et quotas par membre (propriétaire et gestionnaires exemptés), import des membres.
- **Assistant** et Réglages : Emby (bibliothèques, adresse publique), TMDB, Radarr, Sonarr (profils, dossiers), règles et quotas, Webhooks (adresses, jeton régénérable), Discord (facultatif), import Seerr ; secrets chiffrés, jamais renvoyés.
- **Catalogue** : Découvrir, Films/Séries par genre, fiche complète, recherche `Ctrl+K`, images relayées avec cache disque borné.
- **Statuts** calculés côté serveur (disponible, partiel, en téléchargement), épisodes présents/attendus par saison, lien « Regarder dans Emby ».
- **Demandes** : feuille de demande (film, saisons), Mes demandes, bande « Vos demandes en cours », frise ; Approbations (tableau + panneau, cartes sur mobile) avec choix du profil et du dossier, refus motivé, relance des échecs ; envoi à Radarr/Sonarr.
- **Synchronisation** : webhooks Radarr/Sonarr, balayage léger (10 min) et complet (24 h, purges), passage automatique des demandes à « disponible ».
- **Notifications** dans l'appli (cloche), Discord facultatif.
- **Production** : Dockerfile, `compose.yml` durci + Caddy, sauvegarde quotidienne de la base, guide [docs/DEPLOIEMENT.md](docs/DEPLOIEMENT.md).
- **Base** : SQLite (WAL), migrations 0000 à 0009, modèle dans `docs/DATA_MODEL.md`.
- **Tests** : ~455 unitaires et de routes (faux Emby/Radarr/Sonarr/TMDB/Discord/Seerr), ~175 e2e Playwright avec axe à 1440 et 390 px.

## Risques et points de vigilance

| Risque                                                                                                                                                                  | Impact                                         | Traitement                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 4 points des API restants à confirmer (docs/integrations.md ; versions vérifiées : Emby 4.10.2.0, Radarr 7.0.3, Sonarr 4.0.20, Seerr 3.5.2)                             | Statuts, liens ou import faux en production    | Essai sur l'instance réelle avant 6.3                                                                |
| Routes Emby passées à `/Users/Query` et `/Library/VirtualFolders/Query` avec l'en-tête d'authentification `Emby`, d'après la référence 4.10, pas encore testées en réel | Connexion ou liste des bibliothèques en échec  | Le bouton « Tester » de l'assistant le révèle aussitôt ; retour possible aux routes qu'utilise Seerr |
| Radarr/Sonarr doivent joindre l'adresse des webhooks depuis leur conteneur                                                                                              | Statuts mis à jour seulement par les balayages | Vérifier au déploiement ; le balayage de 10 min sert de filet                                        |
| Rebinding DNS pendant l'amorçage (avant propriétaire)                                                                                                                   | Prise de contrôle pendant l'installation       | Accepté, documenté ; installation courte en réseau local                                             |
| Clé de chiffrement `/data/secret.key`                                                                                                                                   | Sauvegarde inutilisable sans elle              | Documenté dans DEPLOIEMENT.md ; la sauvegarder à part                                                |
| Restauration de sauvegarde jamais exercée                                                                                                                               | Perte de données en cas d'incident             | À tester lors du déploiement (6.3)                                                                   |

## Prochaines actions (côté propriétaire)

1. ~~**Logo (3.4)**~~ : fait (R-loupe intégré).
2. **Points restants (0.5)** : confirmer sur l'instance réelle les 4 points de `docs/integrations.md`.
3. ~~**Fusion `dev` → `main`**~~ : faite (#31).
4. **Déploiement (6.3)** : sur le mini-PC à côté de Seerr, avec votre accord ; parcourir l'assistant, tester la restauration, essai avec de vrais membres, puis arrêt de Seerr.
