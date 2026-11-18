# Request — Produit

## En une phrase

Un portail de demandes de films et de séries pour les membres de mon serveur multimédia (Emby, Jellyfin ou Plex, un seul à la fois) : on cherche, on demande, j'approuve, Radarr ou Sonarr télécharge, et le membre est prévenu quand c'est disponible. Remplace Seerr sur le mini-PC.

## Utilisateurs

- **Propriétaire (admin)** : configure l'appli, approuve ou refuse, gère les membres et leurs droits.
- **Membres** : la famille et les amis qui ont un compte sur le serveur multimédia (Emby, Jellyfin ou Plex). Ils se connectent avec ce compte, sans nouvel identifiant.
- Volume réel : une poignée à quelques dizaines de comptes, une seule instance.

## Principes

- **Deux clics pour demander** : depuis n'importe quelle affiche, « Demander » ; pour une série, choix des saisons dans une feuille, « Toutes » présélectionné.
- **Statut toujours lisible** : chaque affiche porte sa pastille (Disponible, Partiellement disponible, Demandé, En cours de téléchargement, Refusé). Jamais un titre déjà présent sur le serveur multimédia proposé à la demande.
- **Configuration guidée** : un assistant au premier lancement (serveur multimédia, puis Radarr, puis Sonarr, puis TMDB, puis notifications), chaque étape testée en direct avec un message clair. Tout réglage reste modifiable ensuite dans « Réglages ». Aucun fichier de configuration à éditer, en dehors de deux variables d'environnement (port, dossier de données).
- **Le serveur fait autorité** : droits, quotas, statuts et disponibilité sont calculés côté serveur.
- Interface en français, raccourcis Windows (`Ctrl+K` pour la recherche, jamais `⌘`).

## Fonctions du MVP

1. **Assistant de configuration** : connexion au serveur multimédia, Emby, Jellyfin ou Plex, un seul à la fois (type d'abord, puis URL et clé d'API, ou jeton du propriétaire pour Plex, et choix des bibliothèques à surveiller ; le type ne change plus une fois des membres inscrits), Radarr et Sonarr (URL, clé, profil de qualité, dossier racine et, pour Sonarr, type de série par défaut, lus depuis leurs API), TMDB (clé ou jeton). Le premier administrateur du serveur multimédia (propriétaire du serveur pour Plex) qui se connecte devient propriétaire.
2. **Connexion** avec les identifiants Emby ou Jellyfin, ou avec le bouton « Se connecter avec Plex » (l'appli vérifie auprès du serveur ou de plex.tv, garde une session à elle, jamais le mot de passe ni le jeton Plex). Import des utilisateurs du serveur à la demande (pour Plex : le propriétaire et les amis qui ont accès au serveur).
3. **Découvrir** : rangées Tendances, Films populaires, Séries populaires, Prochainement, Ajoutés récemment dans le serveur multimédia (« … dans Emby », « … dans Plex »), par genre et par plateforme de streaming (TMDB). Affiches et fonds servis par l'appli avec un cache disque (chargement rapide, pas de dépendance directe du navigateur à TMDB).
4. **Recherche** globale (`Ctrl+K`) : films, séries et personnes, avec statut sur chaque résultat.
5. **Fiche titre** : fond, affiche, synopsis, distribution, bande-annonce, où regarder, saisons et leur statut, recommandations et titres similaires. Bouton « Demander » ou « Regarder dans Emby » (Jellyfin, Plex) si disponible.
6. **Demandes** : film ou saisons choisies ; approbation automatique par droit ; quotas par membre (N films et N saisons sur X jours) ; file d'approbation pour l'admin, avec modification du profil et du dossier avant envoi ; refus avec motif.
7. **Envoi à Radarr / Sonarr** à l'approbation, avec lancement de la recherche.
8. **Synchronisation de disponibilité** : webhooks Radarr/Sonarr (téléchargé), balayage léger du serveur multimédia (ajouté à la bibliothèque ; pour Jellyfin et Plex, les bibliothèques sont relues après un webhook Radarr/Sonarr), et un balayage complet planifié en filet de sécurité. Progression du téléchargement lue dans la file de Radarr/Sonarr.
9. **Mes demandes** et **Toutes les demandes** (admin) : filtres par statut, tri, annulation tant que non traitée.
10. **Notifications dans l'appli** (cloche et compteur) : demande créée (admin), approuvée, refusée, disponible. **Discord facultatif**, désactivé par défaut : un webhook à coller dans Réglages › Notifications pour envoyer les mêmes évènements, rien d'autre à configurer.
11. **Membres et droits** : rôles simples (Membre, Approbation auto, Gestionnaire, Propriétaire) plus droits fins en option ; quotas par défaut et par membre.

## Fonctions après le MVP

Livrées en phase 7 (ROADMAP.md), à partir des fonctions de Seerr listées le 2026-11-17 (tâche 0.4).

12. **Signalements de problèmes** : sur un titre disponible ou partiel, « Signaler un problème » (vidéo, audio, sous-titres, autre ; saison ou épisode facultatifs ; message) ; page « Signalements » avec fil de commentaires, résolution et réouverture. Les gestionnaires voient tout, les membres leurs signalements.
13. **Plusieurs serveurs Radarr et Sonarr** : liste de serveurs dans l'assistant et les Réglages, un par défaut pour chaque type ; l'approbation choisit le serveur, puis le profil et le dossier lus depuis lui ; webhooks et balayages reconnaissent le serveur.
14. **Demandes 4K** : « Demander en 4K » quand un serveur 4K du bon type existe, ouvert à tous les rôles ; la demande d'un membre sans approbation automatique attend un gestionnaire. Statut 4K à part, pastille 4K sur la fiche.
15. **Jellyfin et Plex** au choix, à la place d'Emby (un seul actif, type figé une fois des membres inscrits) : connexion, membres, disponibilité et « Ajoutés récemment » pour chacun ; Plex se connecte par code PIN plex.tv.
16. **Liste de souhaits et import de listes** : « Ajouter à ma liste » sur la fiche et les affiches, page « Ma liste » (statut, retrait, demande) ; import d'une liste publique Trakt (Client ID dans les Réglages) ou du `watchlist.csv` de Letterboxd, avec aperçu puis import sans doublon.
17. **Notifications par courriel** : SMTP dans Réglages › Notifications, adresse et préférence par membre dans Compte, bouton « Envoyer un essai ».
18. **Notifications push web** : activées appareil par appareil dans Compte, clés VAPID créées par l'appli ; exigent HTTPS.
19. **Application installable (PWA)** : manifeste, icônes, page hors ligne ; jamais de cache des données.
20. **Statistiques** (gestionnaires et propriétaire, `canViewStats`) : demandes par statut et par mois, membres et titres les plus actifs, délais moyens d'approbation et de disponibilité, films contre séries, signalements ouverts.
21. **Clé d'API publique** (propriétaire) : clés nommées, montrées une seule fois, révocables ; l'en-tête `X-Api-Key` agit comme le propriétaire qui l'a créée (docs/API.md).
22. **Demander à la place d'un membre** (gestionnaires) : la demande appartient au membre (quota, notifications), l'auteur est conservé.
23. **Exemption de quota au cas par cas** : case « Hors quota » à la demande pour autrui et dans l'approbation.
24. **Blocage de titres** : « Bloquer ce titre » sur la fiche, liste et déblocage dans Réglages › Blocages ; un titre bloqué n'est plus demandable ni visible des membres.
25. **Blocage par mot-clé** : mots-clés TMDB bloqués dans Réglages › Blocages, appliqués aux rangées Découvrir et à la demande.
26. **Masquer dans Découvrir** les titres disponibles ou déjà demandés : deux réglages globaux dans Réglages › Règles.

## Plus tard

Rien de prévu pour l'instant ; la suite dépend de l'usage réel.

## Ce que l'appli ne fait pas

Pas de lecture vidéo (le serveur multimédia et Viewer s'en chargent), pas d'indexeurs ni de client de téléchargement (Prowlarr et qBittorrent restent derrière Radarr/Sonarr).
