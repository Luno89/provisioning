#!/usr/bin/env bash
# bootstrap.sh — Turn a fresh Ubuntu VPS into the No Wrinkles root node.
#
# The root node is the always-on host that runs the platform itself: the UI/API, Mongo, Temporal,
# the Headscale coordination server, and the management k3s cluster. Tenants never run workloads
# here — they attach their own compute (a VPS they rent, or their own hardware over the mesh).
#
# This is what makes the mesh work at all. Headscale hands `server_url` to every client at join
# time, so it has to be an address a machine in someone else's house can actually reach. On a
# laptop it was http://localhost:8080, which told every node to phone itself.
#
# Usage (on the root node, as root):
#   DOMAIN=nowrinkles.dev INGRESS_DOMAIN=nowrinkles.app ACME_EMAIL=you@example.com bash scripts/root-node/bootstrap.sh
#
# Idempotent: safe to re-run. Each step checks before acting.

set -euo pipefail

DOMAIN="${DOMAIN:-nowrinkles.dev}"
APP_DOMAIN="${APP_DOMAIN:-app.${DOMAIN}}"
MESH_DOMAIN="${MESH_DOMAIN:-mesh.${DOMAIN}}"
ACME_EMAIL="${ACME_EMAIL:-admin@${DOMAIN}}"
REPO_DIR="${REPO_DIR:-/opt/nowrinkles}"
ROOT_TLS="${ROOT_TLS:-cloudflare}"
PUBLIC_URL="${PUBLIC_URL:-https://${APP_DOMAIN}}"
LAB_CA=/usr/local/share/ca-certificates/koala-lab.crt
SIGNERS=/etc/koala/release-signers
COSIGN_VERSION=3.1.3
COSIGN_SHA256=4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71
DOCKER_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
NODESOURCE_FINGERPRINT=6F71F525282841EEDAF851B42F59B5F99B1BE0B4
TAILSCALE_FINGERPRINT=2596A99EAAB33821893C0A79458CA832957F5868
NODE_MAJOR=22

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✅${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC}  $1"; }
die()  { echo -e "  ${RED}❌${NC} $1"; exit 1; }
step() { echo -e "\n${GREEN}▶${NC} $1"; }

[ "$(id -u)" -eq 0 ] || die "Run as root — this installs packages and writes systemd units."
case "$ROOT_TLS" in
  cloudflare) LAB=0 ;;
  internal) LAB=1 ;;
  *) die "ROOT_TLS is cloudflare (certificates from Let's Encrypt, proved over Cloudflare DNS) or internal (a lab: Caddy's own authority, no public DNS)" ;;
esac
if [ -z "${INGRESS_DOMAIN:-}" ]; then
  if [ "$LAB" -eq 1 ]; then INGRESS_DOMAIN="$DOMAIN"; else INGRESS_DOMAIN=nowrinkles.app; fi
fi
registered() { echo "$1" | awk -F. '{ print $(NF-1) "." $NF }'; }
if [ "$LAB" -eq 0 ] && [ "$(registered "$INGRESS_DOMAIN")" = "$(registered "$DOMAIN")" ]; then
  die "INGRESS_DOMAIN (${INGRESS_DOMAIN}) must be a different registered domain from DOMAIN (${DOMAIN}): people's instances and apps under root's own domain are the same site as root, so a page anyone deploys could send requests with a visitor's root session"
fi

echo "Bootstrapping the No Wrinkles root node"
[ "$LAB" -eq 1 ] && echo "  lab:  ROOT_TLS=internal — no public DNS, Caddy's own certificate authority"
echo "  app:  https://${APP_DOMAIN}"
echo "  mesh: https://${MESH_DOMAIN}"
echo "  people's instances and apps: https://*.${INGRESS_DOMAIN}"
echo "  repo: ${REPO_DIR}"

# ── 1. DNS ─────────────────────────────────────────────────────────────────────────────────────
# Checked FIRST and treated as fatal. Caddy proves domain control by answering an ACME challenge on
# these names; if they do not resolve here yet, certificate issuance fails and — worse — repeated
# failures burn Let's Encrypt's rate limit of 5 issuances per name per week.
step "Checking DNS"
if [ "$LAB" -eq 1 ]; then
  LOCAL_ADDRESSES=" $(hostname -I) "
  for name in "$APP_DOMAIN" "$MESH_DOMAIN"; do
    resolved="$(getent ahostsv4 "$name" | awk '{print $1}' | head -1)"
    [ -n "$resolved" ] || die "${name} does not resolve on this host. A lab has no public DNS: point it at this machine in /etc/hosts and re-run."
    case "$LOCAL_ADDRESSES" in
      *" ${resolved} "*) ok "${name} → ${resolved} (this host)" ;;
      *) die "${name} resolves to ${resolved}, which is not an address of this host (${LOCAL_ADDRESSES})." ;;
    esac
  done
  PUBLIC_IP="$resolved"
  warn "*.${INGRESS_DOMAIN} is not checked in a lab; whoever reaches this root resolves every name under it to this host themselves"
else
PUBLIC_IP="$(curl -s -m 10 https://api.ipify.org || true)"
[ -n "$PUBLIC_IP" ] || die "Could not determine this host's public IP."
ok "This host is ${PUBLIC_IP}"

# The wildcard is checked via a name that can only resolve through it. Tenant apps are served at
# <app>-<name>.$INGRESS_DOMAIN, and those names are created on demand — there is no per-app DNS record, so
# without the wildcard every app URL is NXDOMAIN and no certificate can ever be issued for one.
for name in "$APP_DOMAIN" "$MESH_DOMAIN" "wildcard-probe.${INGRESS_DOMAIN}"; do
  resolved="$(dig +short A "$name" @1.1.1.1 | tail -1)"
  if [ -z "$resolved" ]; then
    case "$name" in
      wildcard-probe.*) die "No wildcard record: *.${INGRESS_DOMAIN} must point at ${PUBLIC_IP} (DNS-only / grey cloud), or no tenant app URL will resolve." ;;
      *) die "${name} has no A record yet. Point it at ${PUBLIC_IP} (DNS-only / grey cloud) and re-run." ;;
    esac
  elif [ "$resolved" != "$PUBLIC_IP" ]; then
    # The overwhelmingly likely cause is Cloudflare's orange cloud: the A record resolves to a
    # Cloudflare edge IP instead of this host. That breaks Headscale outright — Tailscale clients
    # hold long-lived connections and validate the certificate they are served.
    die "${name} resolves to ${resolved}, not ${PUBLIC_IP}. If this is Cloudflare, set the record to DNS-only (grey cloud)."
  fi
  ok "${name} → ${resolved}"
done
fi

# ── 2. Packages ────────────────────────────────────────────────────────────────────────────────
# Nothing is piped from the internet into a shell: each repository's signing key is fetched once and
# kept only when its fingerprint is the one pinned above, and apt checks every package against it.
step "Installing base packages"
for pkg in git curl dnsutils netcat-openbsd gnupg ca-certificates; do
  dpkg -s "$pkg" &>/dev/null || apt-get install -y "$pkg" >/dev/null
done
ok "git, curl, dnsutils, netcat, gnupg present"

apt_source() {
  local name="$1" key_url="$2" fingerprint="$3" line="$4" keyring="/etc/apt/keyrings/$1.gpg" fetched
  if [ ! -s "$keyring" ]; then
    install -d -m 755 /etc/apt/keyrings
    fetched="$(mktemp)"
    curl -fsSL "$key_url" -o "$fetched"
    gpg --dearmor < "$fetched" > "${fetched}.gpg" 2>/dev/null || cp "$fetched" "${fetched}.gpg"
    gpg --show-keys --with-colons "${fetched}.gpg" 2>/dev/null | awk -F: '/^fpr/ {print $10}' | grep -qx "$fingerprint" \
      || { rm -f "$fetched" "${fetched}.gpg"; die "the ${name} signing key at ${key_url} is not ${fingerprint}; refusing to trust it"; }
    install -m 644 "${fetched}.gpg" "$keyring"
    rm -f "$fetched" "${fetched}.gpg"
  fi
  echo "deb [arch=${ARCH} signed-by=${keyring}] ${line}" > "/etc/apt/sources.list.d/$1.list"
}
. /etc/os-release
ARCH="$(dpkg --print-architecture)"
apt_source docker https://download.docker.com/linux/ubuntu/gpg "$DOCKER_FINGERPRINT" "https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable"
apt_source nodesource https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key "$NODESOURCE_FINGERPRINT" "https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main"
apt_source tailscale "https://pkgs.tailscale.com/stable/ubuntu/${VERSION_CODENAME}.noarmor.gpg" "$TAILSCALE_FINGERPRINT" "https://pkgs.tailscale.com/stable/ubuntu ${VERSION_CODENAME} main"
apt-get update -qq
if ! command -v docker &>/dev/null; then
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  ok "Docker installed from Docker's signed repository"
else
  ok "Docker already present"
fi
if ! command -v node &>/dev/null || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt "$NODE_MAJOR" ]; then
  apt-get install -y nodejs >/dev/null
  ok "Node $(node -v) installed from NodeSource's signed repository"
else
  ok "Node $(node -v) already present"
fi
command -v tailscale >/dev/null || apt-get install -y tailscale >/dev/null
ok "Tailscale $(tailscale version | head -1) present"

if [ "$(/usr/local/bin/cosign version 2>/dev/null | awk '/GitVersion/ {print $2}')" != "v${COSIGN_VERSION}" ]; then
  fetched="$(mktemp)"
  curl -fsSL "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-linux-${ARCH}" -o "$fetched"
  echo "${COSIGN_SHA256}  ${fetched}" | sha256sum -c --quiet - || { rm -f "$fetched"; die "cosign ${COSIGN_VERSION} does not match its pinned checksum"; }
  install -m 755 "$fetched" /usr/local/bin/cosign
  rm -f "$fetched"
fi
ok "cosign v${COSIGN_VERSION}, which checks that GitHub built each release's image"

# ── 3. Repo ────────────────────────────────────────────────────────────────────────────────────
step "Fetching the platform"
if [ ! -d "$REPO_DIR/.git" ]; then
  git clone https://github.com/Luno89/provisioning.git "$REPO_DIR"
  ok "Cloned to ${REPO_DIR}"
else
  git -C "$REPO_DIR" fetch --tags --prune -q || warn "Could not fetch — leaving the working tree alone"
  ok "Repo fetched"
fi
cd "$REPO_DIR"
if [ ! -s "$SIGNERS" ] && [ "$LAB" -eq 1 ] && [ ! -s scripts/root-node/release-signers ]; then
  warn "a lab without release signers checks no tag's signature until ${SIGNERS} is written"
elif [ ! -s "$SIGNERS" ]; then
  [ -s scripts/root-node/release-signers ] || die "the checkout has no scripts/root-node/release-signers, so root could trust no release"
  install -d -m 755 /etc/koala
  install -m 644 scripts/root-node/release-signers "$SIGNERS"
  ok "root trusts releases signed by: $(ssh-keygen -lf "$SIGNERS" 2>/dev/null | awk '{print $2}' | paste -sd, -) — check that this is your release key"
else
  ok "root trusts the release signers in ${SIGNERS} (changed only by hand)"
fi
if [ "$LAB" -eq 0 ]; then
  RELEASE="$(git tag --list 'v*' --sort=-v:refname | head -1)"
  [ -n "$RELEASE" ] || die "there is no release tag yet; make one with npm run release"
  bash scripts/root-node/verify-release.sh tag "$REPO_DIR" "$RELEASE" >/dev/null || die "${RELEASE} is not signed by a key in ${SIGNERS}"
  git checkout -q --detach "$RELEASE"
  ok "on ${RELEASE}, signed by a release key root trusts"
fi
npm ci --ignore-scripts && node scripts/fix-dnd-kit-hoisting.js
# The backend serves this build in production, so Caddy has a single upstream and the browser
# never makes a cross-origin request. Without it the API answers but every page 404s.
npm run build
ok "Frontend built"

step "Hardening the host"
LAB="$LAB" bash "$REPO_DIR/scripts/root-node/harden-host.sh" --fresh

# ── 4. Secrets ─────────────────────────────────────────────────────────────────────────────────
# The five platform keys are generated ONCE. DATA_KEY encrypts every stored credential, so losing or
# regenerating it on a host that already has data makes them permanently undecryptable — copy the
# keys from the old host when migrating. A key that is already set is never touched.
step "Configuring environment"
ENV_FILE="$REPO_DIR/apps/backend/.env"
[ -f "$ENV_FILE" ] || install -m 600 /dev/null "$ENV_FILE"
grep -q '^NODE_ENV=' "$ENV_FILE" || echo "NODE_ENV=production" >> "$ENV_FILE"
for KEY_NAME in SESSION_KEY DATA_KEY PAYLOAD_KEY EGRESS_KEY TEMPORAL_KEY; do
  if grep -qE "^${KEY_NAME}=.{32,}$" "$ENV_FILE"; then
    ok "${KEY_NAME} kept"
  else
    echo "${KEY_NAME}=$(openssl rand -hex 32)" >> "$ENV_FILE"
    ok "${KEY_NAME} generated"
  fi
done
if grep -qE '^ROOT_IDENTITY_KEY=.+$' "$ENV_FILE"; then
  ok "ROOT_IDENTITY_KEY kept"
else
  echo "ROOT_IDENTITY_KEY=$(openssl genpkey -algorithm ed25519 | base64 -w0)" >> "$ENV_FILE"
  ok "ROOT_IDENTITY_KEY generated"
fi
grep -q '^ROLE=' "$ENV_FILE" || echo "ROLE=root" >> "$ENV_FILE"
grep -qE '^ADMIN_SETUP_CODE=.+$' "$ENV_FILE" || echo "ADMIN_SETUP_CODE=$(openssl rand -hex 16)" >> "$ENV_FILE"

# Idempotent upsert, so re-running does not append duplicates.
set_env() {
  grep -q "^$1=" "$ENV_FILE" && sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE" || echo "$1=$2" >> "$ENV_FILE"
}
COMPOSE_ENV="$REPO_DIR/.env"
[ -f "$COMPOSE_ENV" ] || install -m 600 /dev/null "$COMPOSE_ENV"
if ! grep -q '^MONGO_ROOT_PASSWORD=' "$COMPOSE_ENV"; then
  echo "MONGO_ROOT_PASSWORD=$(openssl rand -hex 24)" >> "$COMPOSE_ENV"
  ok "Generated a Mongo root password"
fi
MONGO_ROOT_PASSWORD="$(grep '^MONGO_ROOT_PASSWORD=' "$COMPOSE_ENV" | cut -d= -f2-)"
grep -q '^PLATFORM_BIND=' "$COMPOSE_ENV" || echo "PLATFORM_BIND=127.0.0.1" >> "$COMPOSE_ENV"
if [ "$LAB" -eq 0 ] && ! grep -q '^CLOUDFLARE_API_TOKEN=.' "$COMPOSE_ENV"; then
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "Set CLOUDFLARE_API_TOKEN: a Cloudflare API token with Zone, DNS, Edit on ${DOMAIN} and ${INGRESS_DOMAIN} only. Caddy proves the domain with it for the wildcard certificate *.${INGRESS_DOMAIN}, which every person's address and app is under, and the mail records of ${DOMAIN} are made with it. It stays in ${COMPOSE_ENV}, never in the database."
  echo "CLOUDFLARE_API_TOKEN=${CLOUDFLARE_API_TOKEN}" >> "$COMPOSE_ENV"
fi
for pair in "DOMAIN=${DOMAIN}" "INGRESS_DOMAIN=${INGRESS_DOMAIN}" "APP_DOMAIN=${APP_DOMAIN}" "MESH_DOMAIN=${MESH_DOMAIN}" "ACME_EMAIL=${ACME_EMAIL}" "ROOT_TLS=${ROOT_TLS}"; do
  key="${pair%%=*}"
  grep -q "^${key}=" "$COMPOSE_ENV" && sed -i "s|^${key}=.*|${pair}|" "$COMPOSE_ENV" || echo "$pair" >> "$COMPOSE_ENV"
done
if [ "$LAB" -eq 1 ]; then
  ok "Caddy signs *.${INGRESS_DOMAIN}, ${APP_DOMAIN} and ${MESH_DOMAIN} with its own certificate authority"
else
  ok "Caddy gets the wildcard certificate for *.${INGRESS_DOMAIN} over Cloudflare DNS"
fi

set_env MONGO_URI "mongodb://admin:${MONGO_ROOT_PASSWORD}@127.0.0.1:27017/provisioning?authSource=admin"
set_env MESH_LOGIN_SERVER "https://${MESH_DOMAIN}"
set_env APP_DOMAIN "$APP_DOMAIN"
set_env MESH_DOMAIN "$MESH_DOMAIN"
set_env ACME_EMAIL "$ACME_EMAIL"
set_env INGRESS_DOMAIN "$INGRESS_DOMAIN"
# The origin the browser reaches this host at. Every OAuth redirect_uri and every post-login
# redirect is derived from it; unset, they fall back to localhost and social sign-in cannot work
# (the provider redirects the user's own browser, so localhost means their machine, not this one).
# It also decides whether the session cookie gets the Secure flag — https here, Secure there.
set_env PUBLIC_URL "$PUBLIC_URL"
ok "MESH_LOGIN_SERVER=https://${MESH_DOMAIN} — this is what activates mesh join"
ok "INGRESS_DOMAIN=${INGRESS_DOMAIN} — people's instances at <name>.${INGRESS_DOMAIN}, their apps at <app>-<name>.${INGRESS_DOMAIN}"
ok "PUBLIC_URL=${PUBLIC_URL} — OAuth redirects and Secure cookies key off this"
set_env MAIL_SMTP_URL "smtp://127.0.0.1:2525"
set_env MAIL_FROM "alerts@${DOMAIN}"
ok "MAIL_SMTP_URL — alerts are emailed from alerts@${DOMAIN} through this host's own mail server"

# ── 5. Headscale ───────────────────────────────────────────────────────────────────────────────
# The one-line change that makes every already-written piece of the mesh live.
step "Pointing Headscale at a reachable address"
HS_CONFIG="$REPO_DIR/headscale/config/config.yaml"
sed -i "s|^server_url:.*|server_url: https://${MESH_DOMAIN}|" "$HS_CONFIG"
ok "server_url: https://${MESH_DOMAIN}"

grep -q "acl.hujson" "$HS_CONFIG" || die "Headscale policy path is unset — tenants would not be isolated. See headscale/config/acl.hujson."
ok "ACL policy is wired up"

# ── 6. Firewall ────────────────────────────────────────────────────────────────────────────────
step "Closing every port but SSH, HTTP and HTTPS"
command -v ufw &>/dev/null || apt-get install -y ufw >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
if [ -f /etc/koala/ssh-over-mesh ]; then
  ufw allow in on tailscale0 to any port 22 proto tcp >/dev/null
else
  ufw allow OpenSSH >/dev/null
fi
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow from 10.42.0.0/16 to any >/dev/null
ufw allow from 10.43.0.0/16 to any >/dev/null
ufw --force enable >/dev/null
ok "ufw: only 22, 80 and 443 are reachable from outside; the management cluster's pods and services reach this host"

step "Making the backend's account and folders"
REPO_DIR="$REPO_DIR" bash scripts/root-node/units.sh

# ── 7. Services ────────────────────────────────────────────────────────────────────────────────
step "Starting services"
docker compose -f docker-compose.mongo.yml up -d
bash scripts/temporal-keys.sh
docker compose -f docker-compose.temporal.yml up -d
docker compose -f docker-compose.headscale.yml up -d
docker compose -f docker-compose.caddy.yml up -d --build
docker compose -f docker-compose.mail.yml up -d --build
ok "Mongo, Temporal, Headscale, Caddy and the mail server running"
if [ "$LAB" -eq 1 ]; then
  until docker cp nowrinkles-caddy:/data/caddy/pki/authorities/local/root.crt "$LAB_CA" 2>/dev/null; do
    [ "$(docker inspect -f '{{.State.Running}}' nowrinkles-caddy 2>/dev/null)" = true ] || die "Caddy is not running: docker logs nowrinkles-caddy, and /var/log/koala-caddy/caddy.log"
    sleep 1
  done
  update-ca-certificates >/dev/null
  systemctl restart tailscaled
  ok "this host and its tailscaled trust Caddy's own certificate authority (${LAB_CA})"
fi

for port in 27017 7233 8233 8080 9090 50443 2525; do
  if ss -ltnH "( sport = :$port )" | awk '{print $4}' | grep -qv '^127\.0\.0\.1:'; then
    die "port $port is listening beyond 127.0.0.1 — check PLATFORM_BIND in $COMPOSE_ENV before going further"
  fi
done
ok "Mongo, Temporal and Headscale listen on 127.0.0.1 only"

step "Setting up email"
until docker exec nowrinkles-mail test -s /var/lib/dkim/koala.txt; do sleep 1; done
if [ "$LAB" -eq 1 ]; then
  warn "no public DNS in a lab, so the mail records are not published; the DKIM record would be:"
  docker exec nowrinkles-mail cat /var/lib/dkim/koala.txt | sed 's/^/      /'
else
docker exec nowrinkles-mail cat /var/lib/dkim/koala.txt \
  | CLOUDFLARE_API_TOKEN="$(grep '^CLOUDFLARE_API_TOKEN=' "$COMPOSE_ENV" | cut -d= -f2-)" npx tsx scripts/root-node/mail-dns.ts "$DOMAIN" "$PUBLIC_IP" \
  || die "The mail DNS records could not be set; see above."
fi
if nc -z -w 5 gmail-smtp-in.l.google.com 25 2>/dev/null; then
  ok "Outbound port 25 is open, so mail goes straight to recipients"
else
  warn "Outbound port 25 looks blocked (Hetzner blocks it on new servers until you ask). Ask your host to open it, or set MAIL_RELAYHOST=[host]:587 in ${COMPOSE_ENV} and run: docker compose -f docker-compose.mail.yml up -d"
fi

step "Joining this node to its own mesh"
if ! tailscale ip -4 >/dev/null 2>&1; then
  for _ in $(seq 1 36); do curl -sf -m 5 "https://${MESH_DOMAIN}/health" >/dev/null 2>&1 && break; sleep 5; done
  curl -sf -m 5 "https://${MESH_DOMAIN}/health" >/dev/null 2>&1 || die "https://${MESH_DOMAIN} is not serving yet — Caddy may still be issuing its certificate; re-run bootstrap.sh in a minute"
  docker exec provisioning-headscale headscale users create platform-root >/dev/null 2>&1 || true
  ROOT_USER_ID="$(docker exec provisioning-headscale headscale users list -o json | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const u=JSON.parse(s).find((x)=>x.name==="platform-root");if(!u)process.exit(1);console.log(u.id)})')"
  ROOT_KEY="$(docker exec provisioning-headscale headscale preauthkeys create --user "$ROOT_USER_ID" --tags tag:platform --expiration 10m -o json | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>console.log(JSON.parse(s).key))')"
  MESH_AUTHKEY="$ROOT_KEY" bash "$REPO_DIR/scripts/root-node/join-mesh.sh" "https://${MESH_DOMAIN}" nowrinkles-root >/dev/null \
    || die "this node could not join its own mesh at https://${MESH_DOMAIN}"
fi
ROOT_MESH_IP="$(tailscale ip -4 | head -n1)"
[ -n "$ROOT_MESH_IP" ] || die "this node did not get a mesh address"
if ! grep -qE '^HEADSCALE_API_KEY=.+$' "$ENV_FILE"; then
  set_env HEADSCALE_API_KEY "$(docker exec provisioning-headscale headscale apikeys create --expiration 87600h)"
fi
ok "the backend reaches Headscale with its own API key, never through Docker"
ok "on the mesh as ${ROOT_MESH_IP} (tag:platform)"

step "Starting the image registry for instances"
grep -q '^REGISTRY_MESH_BIND=' "$COMPOSE_ENV" && sed -i "s|^REGISTRY_MESH_BIND=.*|REGISTRY_MESH_BIND=${ROOT_MESH_IP}|" "$COMPOSE_ENV" || echo "REGISTRY_MESH_BIND=${ROOT_MESH_IP}" >> "$COMPOSE_ENV"
set_env INSTANCE_REGISTRY "${ROOT_MESH_IP}:5001"
ufw allow in on tailscale0 to any port 5001 proto tcp >/dev/null
docker compose -f docker-compose.registry.yml up -d
ok "machines pull from ${ROOT_MESH_IP}:5001 over the mesh; root pushes to 127.0.0.1:5000"

# Nothing seeds the catalogues at server start any more, and this host never runs setup.sh — so
# without this a fresh VPS comes up with no tools, personas, packs or tree types. Idempotent: a
# re-run writes nothing when everything already matches.
step "Seeding catalogues"
npx tsx apps/backend/src/scripts/seed-all.ts
ok "Catalogues seeded"

step "Creating the management cluster"
K3S_KUBECONFIG_MODE=600 K3S_SERVER_ARGS="--kube-proxy-arg=nodeport-addresses=127.0.0.1/32,${ROOT_MESH_IP}/32" bash scripts/cluster.sh install provisioning-lunorica || die "native k3s could not be installed"
bash scripts/cluster.sh create provisioning-lunorica || die "the management cluster did not come up"
KOALA_ROOT_NODE=1 bash scripts/ensure-cluster.sh || warn "ensure-cluster.sh reported a problem — check before provisioning"

step "Starting Koala's telemetry collector"
OTEL_IP="$("$REPO_DIR/bin/kubectl" --context k3d-provisioning-lunorica -n monitoring get svc otel-collector -o 'jsonpath={.spec.clusterIP}' 2>/dev/null || true)"
if [ -n "$OTEL_IP" ] && [ "$OTEL_IP" != "None" ]; then
  grep -q '^OTEL_CLUSTER_COLLECTOR=' "$COMPOSE_ENV" && sed -i "s|^OTEL_CLUSTER_COLLECTOR=.*|OTEL_CLUSTER_COLLECTOR=${OTEL_IP}:4317|" "$COMPOSE_ENV" || echo "OTEL_CLUSTER_COLLECTOR=${OTEL_IP}:4317" >> "$COMPOSE_ENV"
  docker compose -f docker-compose.otel.yml up -d
  set_env OTEL_EXPORTER_OTLP_ENDPOINT "http://127.0.0.1:4318"
  ok "Koala's processes and Caddy report through 127.0.0.1:4318 to the collector on the cluster at ${OTEL_IP}"
else
  warn "the cluster has no collector yet; Koala reaches it directly once the cluster worker has installed it, and the next update.sh starts the host collector"
fi

step "Making room for trials on Koala's servers"
sh scripts/root-node/gvisor.sh --yes || die "gVisor could not be set up, and no trial instance may run without it"
TOTAL_MIB=$(( $(awk '/^MemTotal:/ {print $2}' /proc/meminfo) / 1024 ))
ROOT_KEEPS_MIB=8192
SLOT_MIB=10240
SLOTS=$(( TOTAL_MIB > ROOT_KEEPS_MIB ? (TOTAL_MIB - ROOT_KEEPS_MIB) / SLOT_MIB : 0 ))
set_env POOL_SLOTS "$SLOTS"
set_env POOL_SLOT_MEMORY_MIB "$SLOT_MIB"
set_env POOL_ADDRESS "$ROOT_MESH_IP"
set_env POOL_IMAGE "127.0.0.1:5000/nowrinkles/app"
grep -q '^POOL_TRIAL_DAYS=' "$ENV_FILE" || echo "POOL_TRIAL_DAYS=14" >> "$ENV_FILE"
if [ "$SLOTS" -gt 0 ]; then
  ok "${SLOTS} trial instances fit in ${TOTAL_MIB} MiB, ${SLOT_MIB} MiB each after ${ROOT_KEEPS_MIB} MiB for root itself"
else
  warn "${TOTAL_MIB} MiB leaves no room for trial instances; people will be asked to use their own machine"
fi

# ── 8. systemd ─────────────────────────────────────────────────────────────────────────────────
# Without this the platform dies on reboot and every tenant loses the ability to provision.
step "Installing the systemd unit"
REPO_DIR="$REPO_DIR" bash scripts/root-node/units.sh
ok "nowrinkles.service and nowrinkles-workers.service enabled (start them once you have verified the build)"

if [ "$LAB" -eq 1 ]; then
  warn "a lab follows no published releases: update it with update.sh"
else
  step "Following published releases"
  cat > /etc/systemd/system/koala-release-watch.service <<UNIT
[Unit]
Description=Move root onto a newer published release
After=nowrinkles.service network-online.target

[Service]
Type=oneshot
Environment=REPO_DIR=${REPO_DIR}
ExecStart=/bin/bash ${REPO_DIR}/scripts/root-node/release-watch.sh
UNIT
  cat > /etc/systemd/system/koala-release-watch.timer <<UNIT
[Unit]
Description=Look for a newer published release every hour

[Timer]
OnBootSec=15min
OnUnitActiveSec=1h
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable koala-release-watch.timer
  ok "koala-release-watch.timer looks for a newer release every hour (systemctl disable --now koala-release-watch.timer to stop)"
fi

# ── 9. Verify ──────────────────────────────────────────────────────────────────────────────────
step "Verifying"
sleep 5
if curl -sf -m 15 "https://${MESH_DOMAIN}/health" >/dev/null 2>&1; then
  ok "https://${MESH_DOMAIN} is serving with a valid certificate"
else
  warn "Headscale is not answering over TLS yet — Caddy may still be issuing. Check: /var/log/koala-caddy/caddy.log"
fi

echo
echo "Next:"
echo "  1. systemctl start nowrinkles"
[ "$LAB" -eq 1 ] && echo "  2. Publish the first instance image:  bash scripts/root-node/update.sh"
[ "$LAB" -eq 1 ] || echo "  2. Publish the first instance image:  bash scripts/root-node/release-watch.sh   (the newest signed release, its image checked with cosign)"
echo "  3. Sign up the first account at ${PUBLIC_URL} with this setup code in the invite field:"
echo "       $(grep '^ADMIN_SETUP_CODE=' "$ENV_FILE" | cut -d= -f2-)"
echo "     It becomes the admin, the only one who can make invites; nobody can sign up without the code."
[ "$LAB" -eq 1 ] || echo "  4. Once it works, let root follow published releases:  systemctl start koala-release-watch.timer"
echo
echo "Optional — Google/GitHub sign-in (email+password works without it):"
echo "  Register an OAuth app with these exact redirect URIs, then add the ids to"
echo "  ${ENV_FILE} and restart:"
echo "    Google : ${PUBLIC_URL}/api/auth/google/callback"
echo "    GitHub : ${PUBLIC_URL}/api/auth/github/callback"
echo "  Keys: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET."
echo "  Left unset, those buttons return 501 rather than falling back to the dev mock login."
