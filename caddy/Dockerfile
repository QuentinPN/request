# Caddy avec le module DNS Cloudflare : certificat obtenu par défi DNS-01, sans exposer l'hôte à Internet.
# Le Caddyfile est inclus : compose.local.yml n'a besoin d'aucun fichier du dépôt.
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile.local /etc/caddy/Caddyfile
