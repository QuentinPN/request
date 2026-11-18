# Déploiement

Request tourne dans un seul conteneur Docker (`linux/amd64`, Node 26), derrière Caddy pour le HTTPS. Tout ce qui doit survivre vit dans le volume `/data` : la base SQLite (`request.db`), la clé de chiffrement des secrets (`secret.key`), le cache d'images (`cache/images/`) et les sauvegardes (`backups/`).

## Installer

Prérequis : Docker avec Compose v2, un nom de domaine qui pointe vers l'hôte, les ports 80 et 443 joignables depuis Internet (Caddy en a besoin pour obtenir le certificat).

```sh
git clone https://github.com/QuentinPN/Request.git && cd Request
cp .env.example .env        # renseigner DOMAIN
docker compose up -d --build
docker compose ps           # request doit passer « healthy »
```

Variables (`.env`, voir `.env.example`) :

| Variable             | Défaut           | Rôle                                                                                                                         |
| -------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `DOMAIN`             | (obligatoire)    | Domaine public ; Caddy y obtient et renouvelle le certificat.                                                                |
| `PROXY_SUBNET`       | `172.28.80.0/24` | Sous-réseau du réseau Caddy ↔ appli. Il devient `TRUST_PROXY` : l'appli ne croit `X-Forwarded-*` que de ce sous-réseau.      |
| `IMAGE_CACHE_MAX_MB` | `500`            | Taille maximale du cache d'images ; les fichiers les moins récemment vus sont supprimés au-delà.                             |
| `BACKUP_KEEP`        | `7`              | Sauvegardes quotidiennes conservées dans `/data/backups` ; `0` désactive la sauvegarde automatique.                          |
| `SETUP_TOKEN`        | (aléatoire)      | Jeton d'installation demandé par l'assistant tant qu'aucun propriétaire n'existe ; vide : tiré au hasard à chaque démarrage. |

Variables de l'appli, déjà fixées par l'image : `PORT=3000`, `DATA_DIR=/data`. `HOST` (défaut `0.0.0.0`) n'a pas à changer. `compose.yml` fixe aussi `PUBLIC_URL=https://${DOMAIN}` : lien vers l'appli dans les courriels et contact des notifications push (hors Compose, renseignez-la à la main ; sans elle, les courriels n'ont pas de lien).

### Notifications par courriel et push

- **Courriel** (facultatif) : Réglages › Notifications par courriel. L'appli se connecte au serveur SMTP en sortie : le port choisi (587 STARTTLS, 465 TLS, 25 sans chiffrement) doit être ouvert en sortie depuis l'hôte (beaucoup de fournisseurs d'accès bloquent le 25 : préférez 587 ou 465 d'un service d'envoi). « Envoyer un essai » écrit à l'adresse du propriétaire, à renseigner d'abord dans Compte. Chaque membre saisit son adresse et ses choix dans Compte.
- **Push** : rien à régler côté serveur (clés VAPID créées au premier besoin). Il exige l'appli en HTTPS (Caddy s'en charge) ; chaque membre l'active sur chacun de ses appareils dans Compte. Sur iPhone et iPad (iOS 16.4 et plus), il faut d'abord ajouter l'appli à l'écran d'accueil (Partager › Sur l'écran d'accueil).
- **Appli installable** : Chrome, Edge et Android proposent « Installer l'application » ; le manifeste et le service worker sont servis par l'appli, sans réglage.

Le conteneur est durci : système de fichiers en lecture seule (hors `/data` et `/tmp`), `cap_drop: [ALL]`, `no-new-privileges`, utilisateur `node` (uid 1000), aucun port publié (seul Caddy joint l'appli).

### Clé de chiffrement des secrets

Les clés d'API (Radarr, Sonarr, TMDB, Emby) sont chiffrées en base (AES-256-GCM) avec la clé `/data/secret.key`. L'appli la **crée toute seule au premier lancement** (32 octets aléatoires en base64, lisible par son seul propriétaire) ; il n'y a rien à faire. Pour imposer la vôtre, déposez-la dans le volume **avant** le premier démarrage :

```sh
docker volume create request_data
docker run --rm -v request_data:/data alpine sh -c \
  'umask 077; head -c 32 /dev/urandom | base64 > /data/secret.key; chown 1000:1000 /data/secret.key'
```

**Sans cette clé, la base est inutilisable** (les secrets ne se déchiffrent plus) : gardez-en une copie, séparée des sauvegardes de la base si celles-ci quittent le serveur.

### Assistant du premier lancement

Ouvrez `https://<DOMAIN>`. Tant qu'aucun propriétaire n'existe, l'assistant guide la configuration : serveur multimédia (Emby, Jellyfin ou Plex : adresse et clé ou jeton), Radarr, Sonarr, TMDB, règles de demande, puis la connexion d'un administrateur du serveur multimédia (propriétaire du serveur pour Plex), qui devient propriétaire.

Le premier écran demande le **jeton d'installation** : sans lui, n'importe qui joignant l'appli avant vous pourrait la brancher sur son propre serveur et s'en déclarer propriétaire. Il est écrit dans les journaux au démarrage, tant qu'aucun propriétaire n'existe :

```sh
docker compose logs request | grep "Jeton d’installation"
```

Il change à chaque redémarrage, sauf si `SETUP_TOKEN` est renseigné dans `.env` : les journaux écrivent alors « celui de la variable SETUP_TOKEN » sans le répéter. Après 10 jetons faux en 5 minutes depuis une même adresse, l'assistant répond « Trop de jetons d’installation invalides », même avec le bon jeton : patientez quelques minutes. Une fois le propriétaire connecté, le jeton ne sert plus.

Radarr, Sonarr et le serveur multimédia tournent sur l'hôte : dans l'assistant, utilisez `http://host.docker.internal:<port>` (déclaré dans `compose.yml`). S'ils sont dans un autre réseau Docker, rattachez-y le service `request` (ou l'inverse) et utilisez le nom de leur conteneur.

### Webhooks Radarr et Sonarr

Dans Request, **Réglages › Connexions › Webhook de Radarr et Sonarr** (propriétaire) affiche les deux adresses toutes prêtes :

- `https://<DOMAIN>/api/webhooks/radarr?token=…`
- `https://<DOMAIN>/api/webhooks/sonarr?token=…`

Dans Radarr (puis Sonarr) : Réglages › Connect › Ajouter › Webhook, coller l'adresse, méthode `POST`, cocher au moins « On Grab », « On Import/Download » et les suppressions, puis « Test ». Si votre version propose le champ « Headers », préférez `X-Webhook-Token: <jeton>` à `?token=` (le jeton reste hors des journaux d'accès de Caddy). Le jeton se régénère depuis les Réglages ; l'ancien cesse aussitôt.

Si Radarr ou Sonarr ne parvient pas à joindre le domaine public depuis l'hôte (pas de « hairpin NAT »), rattachez leur conteneur au réseau `request_proxy` et utilisez `http://request:3000/api/webhooks/…?token=…`.

## Cohabiter avec Seerr sur le mini-PC

Les deux tournent dans des conteneurs distincts : donnez à Request son propre domaine (ou sous-domaine) et son propre volume ; Seerr garde le sien et son port (5055 par défaut), sans rien partager. Les deux peuvent interroger Radarr, Sonarr et Emby en même temps. Pendant l'essai, ne laissez qu'un seul des deux envoyer à Radarr/Sonarr pour une même personne, afin d'éviter les doublons.

Si un Caddy tourne déjà sur l'hôte (ports 80/443 pris), ne démarrez pas le service `caddy` : lancez `docker compose up -d --build request`, rattachez votre Caddy au réseau `request_proxy`, ajoutez à son Caddyfile le bloc de `Caddyfile` de ce dépôt, et fixez `PROXY_SUBNET` au sous-réseau du réseau (ou à l'adresse de votre Caddy) pour que `TRUST_PROXY` le couvre.

## Sauvegarde et restauration

La base est sauvegardée **à chaud** (API de sauvegarde de SQLite, cohérente même pendant des écritures) dans `/data/backups/request-AAAAMMJJ-HHMMSS.db` (UTC) :

- automatiquement une fois par jour (la dernière a plus de 24 h), en gardant les `BACKUP_KEEP` dernières ;
- à la demande : `docker compose exec request node scripts/backup.ts` (en local, hors Docker : `npm run backup`).

Une copie dans le même volume ne protège pas d'un disque perdu : copiez régulièrement `backups/` **et** `secret.key` ailleurs.

```sh
# Copier les sauvegardes et la clé vers l'hôte
docker cp request-request-1:/data/backups ./sauvegardes
docker cp request-request-1:/data/secret.key ./sauvegardes/
```

Restaurer (sur la même clé `secret.key`) :

```sh
docker compose stop request
docker run --rm -v request_data:/data -v "$PWD/sauvegardes:/src:ro" alpine sh -c '
  rm -f /data/request.db-wal /data/request.db-shm
  cp /src/request-AAAAMMJJ-HHMMSS.db /data/request.db
  chown 1000:1000 /data/request.db'
# Nouvelle machine : remettre aussi secret.key (chmod 600, chown 1000:1000) dans /data avant de démarrer.
docker compose start request
```

Supprimez les fichiers `-wal` et `-shm` : ils appartiennent à l'ancienne base et corrompraient la copie restaurée.

## Mettre à jour

```sh
git pull
docker compose up -d --build
docker image prune -f
```

Les migrations de base s'appliquent toutes seules au démarrage. Avant une mise à jour qui change le schéma, lancez une sauvegarde à la demande. Retour arrière : revenir au commit précédent, reconstruire, et restaurer la dernière sauvegarde si une migration a déjà tourné.

## Dépannage

- `docker compose logs -f request` pour les journaux ; `docker inspect --format '{{.State.Health.Status}}' request-request-1` pour l'état de santé (`GET /api/health` vérifie aussi la base).
- Connexion impossible derrière Caddy, ou trop de tentatives refusées pour tout le monde : `TRUST_PROXY` ne couvre pas l'adresse de Caddy (voir `PROXY_SUBNET`).
- `EACCES` sur `/data` : le volume n'appartient pas à l'uid 1000 (`docker run --rm -v request_data:/data alpine chown -R 1000:1000 /data`).
