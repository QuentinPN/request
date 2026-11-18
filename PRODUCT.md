# Request — Produit

## En une phrase

Un portail de demandes de films et de séries pour les membres de mon serveur Emby : on cherche, on demande, j'approuve, Radarr ou Sonarr télécharge, et le membre est prévenu quand c'est disponible. Remplace Seerr sur le mini-PC.

## Utilisateurs

- **Propriétaire (admin)** : configure l'appli, approuve ou refuse, gère les membres et leurs droits.
- **Membres** : la famille et les amis qui ont un compte sur le serveur multimédia (Emby, Jellyfin ou Plex). Ils se connectent avec ce compte, sans nouvel identifiant.
- Volume réel : une poignée à quelques dizaines de comptes, une seule instance.

## Principes

- **Deux clics pour demander** : depuis n'importe quelle affiche, « Demander » ; pour une série, choix des saisons dans une feuille, « Toutes » présélectionné.
- **Statut toujours lisible** : chaque affiche porte sa pastille (Disponible, Partiellement disponible, Demandé, En cours de téléchargement, Refusé). Jamais un titre déjà présent dans Emby proposé à la demande.
- **Configuration guidée** : un assistant au premier lancement (Emby, puis Radarr, puis Sonarr, puis TMDB, puis notifications), chaque étape testée en direct avec un message clair. Tout réglage reste modifiable ensuite dans « Réglages ». Aucun fichier de configuration à éditer, en dehors de deux variables d'environnement (port, dossier de données).
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
8. **Synchronisation de disponibilité** : webhooks Radarr/Sonarr (téléchargé), webhook ou balayage léger d'Emby (ajouté à la bibliothèque), et un balayage complet planifié en filet de sécurité. Progression du téléchargement lue dans la file de Radarr/Sonarr.
9. **Mes demandes** et **Toutes les demandes** (admin) : filtres par statut, tri, annulation tant que non traitée.
10. **Notifications dans l'appli** (cloche et compteur) : demande créée (admin), approuvée, refusée, disponible. **Discord facultatif**, désactivé par défaut : un webhook à coller dans Réglages › Notifications pour envoyer les mêmes évènements, rien d'autre à configurer.
11. **Membres et droits** : rôles simples (Membre, Approbation auto, Gestionnaire, Propriétaire) plus droits fins en option ; quotas par défaut et par membre.

## Plus tard (hors MVP)

Signalement de problèmes sur un titre, demandes 4K (second Radarr/Sonarr), liste de souhaits et import de listes (Trakt, Letterboxd), Jellyfin et Plex, plusieurs serveurs Radarr/Sonarr, notifications courriel et push web, blocage de titres, statistiques, application mobile installable (PWA), demander à la place d'un membre, masquer dans Découvrir les titres disponibles ou déjà demandés, blocage par mot-clé, exemption de quota au cas par cas, clé d'API publique de l'appli. Liste complétée à partir de Seerr le 2026-11-17 (tâche 0.4).

## Ce que l'appli ne fait pas

Pas de lecture vidéo (Emby et Viewer s'en chargent), pas d'indexeurs ni de client de téléchargement (Prowlarr et qBittorrent restent derrière Radarr/Sonarr).
