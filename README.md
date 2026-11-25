<div align="center">

# Request

**A request portal for your home media server: search, ask, approve, watch.**

English | [Français](README.fr.md)

Request lets the people who share your Emby server (Jellyfin and Plex support is experimental) ask for the films and series they want, in two
clicks. You approve, your library tools take care of the rest, and everyone is told when the title is ready to watch.

<img src="docs/screenshots/request.webp" alt="The Request home page: a featured title, the requests in progress with their steps, and rows of trending films" width="900">

</div>

## Highlights

- **Two clicks to ask.** Pick a film or a series, choose the seasons you want, and send. Titles already on the
  server are clearly marked, so nobody asks for the same thing twice.
- **Browse like a streaming app.** Trending, popular, upcoming, recently added, by genre or by streaming platform,
  with a global search (`Ctrl+K`) across films, series and people.
- **Full control for the owner.** A simple approval queue with accept or refuse (with a reason), automatic approval
  for trusted members, per-member quotas, and four roles: Member, Auto-approve, Manager and Owner.
- **Always know where a request stands.** Each request shows its progress from requested to approved to ready, and
  availability is synced automatically with Radarr, Sonarr and your media server.
- **Notified wherever you are.** In-app bell, email, web push and Discord, so members hear back without asking.
- **Sign in with the account you already have.** Members use their media server login, with nothing new to create or
  remember.
- **Installs like an app, runs anywhere.** A single Docker container with a built-in database and automatic daily
  backups. It also installs on a phone as a web app.

More than the basics: 4K requests, several Radarr and Sonarr servers, problem reports on titles, a personal watchlist
with Trakt and Letterboxd import, usage statistics, title blocking, and a public API.

> The interface is currently in French.

## How it works

```mermaid
flowchart LR
    A[Member searches<br/>and requests] --> B{Approval}
    B -->|Auto-approved or<br/>owner accepts| C[Sent to<br/>Radarr / Sonarr]
    B -->|Refused, with a reason| E
    C --> D[Added to the<br/>media server library]
    D --> E[Member is notified]
```

1. A member signs in with their media server account, finds a film or a series and requests it.
2. Depending on their role and quota, the request is approved on the spot or waits in the owner's queue.
3. Once approved, it is handed to Radarr (films) or Sonarr (series), which put it in the library.
4. Request notices the title has arrived, updates its status everywhere and notifies the member.

## Quick start

You need Docker with Compose v2, a domain name pointing at your machine, and ports 80 and 443 reachable (Caddy uses
them to get the HTTPS certificate automatically).

```sh
git clone https://github.com/QuentinPN/request.git && cd request
cp .env.example .env              # set DOMAIN
docker compose up -d --build
docker compose logs               # look for the one-time setup token
```

Open `https://<your domain>`: a guided setup connects your media server, Radarr, Sonarr and TMDB, testing each step
live. The first media server administrator to sign in becomes the owner. Local-network-only setup, backups and
updates are covered in the [deployment guide](docs/DEPLOIEMENT.md) (in French).

## Built with

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

## For developers

Local development, tests, project layout and further technical documents are in the
[developer guide](docs/DEVELOPMENT.md) (in French).

## License

[MIT](LICENSE)
