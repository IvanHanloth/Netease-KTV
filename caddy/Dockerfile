# HTTPS front for Netease KTV: Caddy with the Cloudflare DNS plugin, so certificates for a
# domain that points at a LAN address can be issued and renewed (DNS-01 challenge; nothing has to
# be reachable from the internet).
# The builder runs on the build machine's own platform and cross-compiles (Go needs no emulation).
FROM --platform=$BUILDPLATFORM caddy:2-builder AS builder
ARG TARGETOS
ARG TARGETARCH
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH xcaddy build --with github.com/caddy-dns/cloudflare --output /out/caddy

FROM caddy:2
COPY --from=builder /out/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
