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

| Risque                                                                                                                 | Impact                                         | Traitement                                                    |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| Points [?] des API (Emby `AnyProviderIdEquals`, lien profond et `serverId`, noms d'événements Sonarr, champs de Seerr) | Statuts, liens ou import faux en production    | 0.5 : essai sur le mini-PC avant 6.3                          |
| Radarr/Sonarr doivent joindre l'adresse des webhooks depuis leur conteneur                                             | Statuts mis à jour seulement par les balayages | Vérifier au déploiement ; le balayage de 10 min sert de filet |
| Rebinding DNS pendant l'amorçage (avant propriétaire)                                                                  | Prise de contrôle pendant l'installation       | Accepté, documenté ; installation courte en réseau local      |
| Clé de chiffrement `/data/secret.key`                                                                                  | Sauvegarde inutilisable sans elle              | Documenté dans DEPLOIEMENT.md ; la sauvegarder à part         |
| Restauration de sauvegarde jamais exercée                                                                              | Perte de données en cas d'incident             | À tester lors du déploiement (6.3)                            |

## Prochaines actions (côté propriétaire)

1. **Logo (3.4)** : choisir entre les finalistes de `docs/logo/round2/final` (R-loupe ou U négatif), puis intégration.
2. **Versions réelles (0.5)** : fournir les versions d'Emby, Radarr, Sonarr et Seerr du mini-PC pour lever les points [?].
3. **Fusion `dev` → `main`** : à faire avec votre accord.
4. **Déploiement (6.3)** : sur le mini-PC à côté de Seerr, avec votre accord ; parcourir l'assistant, tester la restauration, essai avec de vrais membres, puis arrêt de Seerr.
