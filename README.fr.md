<div align="center">

# Request

**Un portail de demandes pour votre serveur multimédia : on cherche, on demande, on approuve, on regarde.**

[English](README.md) | Français

Request permet à ceux qui partagent votre serveur Emby, Jellyfin ou Plex de demander les films et séries qu'ils
veulent, en deux clics. Vous approuvez, vos outils de bibliothèque font le reste, et chacun est prévenu quand le titre
est prêt à regarder.

<img src="docs/screenshots/request.webp" alt="La page d'accueil de Request : un titre à la une, les demandes en cours avec leurs étapes et des rangées de films tendance" width="900">

</div>

## Points forts

- **Deux clics pour demander.** On choisit un film ou une série, on coche les saisons voulues, et c'est parti. Les
  titres déjà présents sur le serveur sont clairement signalés : personne ne demande deux fois la même chose.
- **Une navigation de plateforme de streaming.** Tendances, populaires, prochainement, ajoutés récemment, par genre
  ou par plateforme, avec une recherche globale (`Ctrl+K`) dans les films, les séries et les personnes.
- **Le contrôle au propriétaire.** Une file d'approbation simple (accepter ou refuser, avec un motif),
  l'approbation automatique pour les membres de confiance, des quotas par membre et quatre rôles : Membre,
  Approbation auto, Gestionnaire et Propriétaire.
- **Toujours savoir où en est une demande.** Chaque demande affiche sa progression, de demandée à approuvée puis
  prête, et la disponibilité se synchronise toute seule avec Radarr, Sonarr et votre serveur multimédia.
- **Des notifications où que l'on soit.** Cloche dans l'appli, courriel, notifications push web et Discord : les
  membres sont prévenus sans avoir à demander.
- **Le compte que l'on a déjà.** Les membres se connectent avec leur compte du serveur multimédia, sans rien créer ni
  retenir de nouveau.
- **S'installe comme une appli, tourne partout.** Un seul conteneur Docker, avec sa base de données intégrée et des
  sauvegardes quotidiennes automatiques. Elle s'installe aussi sur un téléphone comme une application web.

Et au-delà des bases : demandes en 4K, plusieurs serveurs Radarr et Sonarr, signalement de problèmes sur un titre,
liste de souhaits avec import Trakt et Letterboxd, statistiques d'usage, blocage de titres et API publique.

> L'interface est en français.

## Comment ça marche

```mermaid
flowchart LR
    A[Le membre cherche<br/>et demande] --> B{Approbation}
    B -->|Approuvée d'office ou<br/>acceptée par le propriétaire| C[Envoyée à<br/>Radarr / Sonarr]
    B -->|Refusée, avec un motif| E
    C --> D[Ajoutée à la bibliothèque<br/>du serveur multimédia]
    D --> E[Le membre est prévenu]
```

1. Un membre se connecte avec son compte du serveur multimédia, trouve un film ou une série et le demande.
2. Selon son rôle et son quota, la demande est approuvée tout de suite ou attend dans la file du propriétaire.
3. Une fois approuvée, elle est confiée à Radarr (films) ou Sonarr (séries), qui l'ajoutent à la bibliothèque.
4. Request voit arriver le titre, met à jour son statut partout et prévient le membre.

## Démarrage rapide

Il faut Docker avec Compose v2, un nom de domaine qui pointe vers votre machine, et les ports 80 et 443 joignables
(Caddy s'en sert pour obtenir le certificat HTTPS automatiquement).

```sh
git clone https://github.com/QuentinPN/request.git && cd request
cp .env.example .env              # renseigner DOMAIN
docker compose up -d --build
docker compose logs               # cherchez le jeton d'installation, affiché une seule fois
```

Ouvrez `https://<votre domaine>` : un assistant guide la connexion du serveur multimédia, de Radarr, de Sonarr et de
TMDB, en testant chaque étape en direct. Le premier administrateur du serveur multimédia qui se connecte devient
propriétaire. Réseau local seul, sauvegardes et mises à jour : voir le [guide de déploiement](docs/DEPLOIEMENT.md).

## Stack

![Bun](https://img.shields.io/badge/Bun-000000?logo=bun&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React_19-20232A?logo=react&logoColor=61DAFB)
![TanStack](https://img.shields.io/badge/TanStack_Router_&_Query-FF4154?logo=reactquery&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS_4-06B6D4?logo=tailwindcss&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify_5-000000?logo=fastify&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white)
![Drizzle ORM](https://img.shields.io/badge/Drizzle_ORM-C5F74F?logo=drizzle&logoColor=black)
![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)
![Caddy](https://img.shields.io/badge/Caddy-1F88C0?logo=caddy&logoColor=white)

## Pour les développeurs

Développement local, tests, organisation du projet et autres documents techniques : voir le
[guide développeur](docs/DEVELOPMENT.md).

## Licence

[MIT](LICENSE)
