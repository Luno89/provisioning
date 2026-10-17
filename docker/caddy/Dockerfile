FROM caddy:2.10.2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare@v0.2.1

FROM caddy:2.10.2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY tls /etc/caddy/tls
