FROM caddy:2.10.2-builder AS builder
COPY modules.txt /tmp/modules.txt
RUN xcaddy build $(sed 's/^/--with /' /tmp/modules.txt)

FROM caddy:2.10.2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
