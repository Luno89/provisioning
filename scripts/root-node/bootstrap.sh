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
#   DOMAIN=nowrinkles.dev ACME_EMAIL=you@example.com bash scripts/root-node/bootstrap.sh
#
# Idempotent: safe to re-run. Each step checks before acting.

set -euo pipefail

DOMAIN="${DOMAIN:-nowrinkles.dev}"
APP_DOMAIN="${APP_DOMAIN:-app.${DOMAIN}}"
MESH_DOMAIN="${MESH_DOMAIN:-mesh.${DOMAIN}}"
ACME_EMAIL="${ACME_EMAIL:-admin@${DOMAIN}}"
REPO_DIR="${REPO_DIR:-/opt/nowrinkles}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✅${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC}  $1"; }
die()  { echo -e "  ${RED}❌${NC} $1"; exit 1; }
step() { echo -e "\n${GREEN}▶${NC} $1"; }

[ "$(id -u)" -eq 0 ] || die "Run as root — this installs packages and writes systemd units."

echo "Bootstrapping the No Wrinkles root node"
echo "  app:  https://${APP_DOMAIN}"
echo "  mesh: https://${MESH_DOMAIN}"
echo "  repo: ${REPO_DIR}"

# ── 1. DNS ─────────────────────────────────────────────────────────────────────────────────────
# Checked FIRST and treated as fatal. Caddy proves domain control by answering an ACME challenge on
# these names; if they do not resolve here yet, certificate issuance fails and — worse — repeated
# failures burn Let's Encrypt's rate limit of 5 issuances per name per week.
step "Checking DNS"
PUBLIC_IP="$(curl -s -m 10 https://api.ipify.org || true)"
[ -n "$PUBLIC_IP" ] || die "Could not determine this host's public IP."
ok "This host is ${PUBLIC_IP}"

# The wildcard is checked via a name that can only resolve through it. Tenant apps are served at
# <app>-<id>.$DOMAIN, and those names are created on demand — there is no per-app DNS record, so
# without the wildcard every app URL is NXDOMAIN and no certificate can ever be issued for one.
for name in "$APP_DOMAIN" "$MESH_DOMAIN" "wildcard-probe.${DOMAIN}"; do
  resolved="$(dig +short A "$name" @1.1.1.1 | tail -1)"
  if [ -z "$resolved" ]; then
    case "$name" in
      wildcard-probe.*) die "No wildcard record: *.${DOMAIN} must point at ${PUBLIC_IP} (DNS-only / grey cloud), or no tenant app URL will resolve." ;;
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

# ── 2. Packages ────────────────────────────────────────────────────────────────────────────────
step "Installing base packages"
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  ok "Docker installed"
else
  ok "Docker already present"
fi

if ! command -v node &>/dev/null || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  ok "Node $(node -v) installed"
else
  ok "Node $(node -v) already present"
fi

for pkg in git curl dnsutils; do
  dpkg -s "$pkg" &>/dev/null || apt-get install -y "$pkg"
done
ok "git, curl, dnsutils present"

# ── 3. Repo ────────────────────────────────────────────────────────────────────────────────────
step "Fetching the platform"
if [ ! -d "$REPO_DIR/.git" ]; then
  git clone https://github.com/Luno89/provisioning.git "$REPO_DIR"
  ok "Cloned to ${REPO_DIR}"
else
  git -C "$REPO_DIR" pull --ff-only || warn "Could not fast-forward — leaving the working tree alone"
  ok "Repo up to date"
fi
cd "$REPO_DIR"
npm ci
# The backend serves this build in production, so Caddy has a single upstream and the browser
# never makes a cross-origin request. Without it the API answers but every page 404s.
npm run build
ok "Frontend built"

# ── 4. Secrets ─────────────────────────────────────────────────────────────────────────────────
# JWT_SECRET is generated ONCE. crypto.ts derives the AES-256-GCM master key from it, so if it ever
# changes, every credential a tenant has stored becomes permanently undecryptable. Never
# regenerate it on a host that already has data — copy it from the old one when migrating.
step "Configuring environment"
ENV_FILE="$REPO_DIR/apps/backend/.env"
if [ ! -f "$ENV_FILE" ]; then
  install -m 600 /dev/null "$ENV_FILE"
  {
    echo "JWT_SECRET=$(openssl rand -hex 32)"
    echo "NODE_ENV=production"
  } >> "$ENV_FILE"
  ok "Generated a new .env (JWT_SECRET created)"
else
  ok "Existing .env kept — JWT_SECRET left untouched"
fi

# Idempotent upsert, so re-running does not append duplicates.
set_env() {
  grep -q "^$1=" "$ENV_FILE" && sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE" || echo "$1=$2" >> "$ENV_FILE"
}
set_env MESH_LOGIN_SERVER "https://${MESH_DOMAIN}"
set_env APP_DOMAIN "$APP_DOMAIN"
set_env MESH_DOMAIN "$MESH_DOMAIN"
set_env ACME_EMAIL "$ACME_EMAIL"
# Apps are served at <app>-<id>.$DOMAIN. Without this, exposePublic refuses outright rather than
# handing out a URL that would not resolve.
set_env INGRESS_DOMAIN "$DOMAIN"
# The origin the browser reaches this host at. Every OAuth redirect_uri and every post-login
# redirect is derived from it; unset, they fall back to localhost and social sign-in cannot work
# (the provider redirects the user's own browser, so localhost means their machine, not this one).
# It also decides whether the session cookie gets the Secure flag — https here, Secure there.
set_env PUBLIC_URL "https://${APP_DOMAIN}"
ok "MESH_LOGIN_SERVER=https://${MESH_DOMAIN} — this is what activates mesh join"
ok "INGRESS_DOMAIN=${DOMAIN} — this is what activates public app URLs"
ok "PUBLIC_URL=https://${APP_DOMAIN} — OAuth redirects and Secure cookies key off this"

# ── 5. Headscale ───────────────────────────────────────────────────────────────────────────────
# The one-line change that makes every already-written piece of the mesh live.
step "Pointing Headscale at a reachable address"
HS_CONFIG="$REPO_DIR/headscale/config/config.yaml"
sed -i "s|^server_url:.*|server_url: https://${MESH_DOMAIN}|" "$HS_CONFIG"
ok "server_url: https://${MESH_DOMAIN}"

grep -q "acl.hujson" "$HS_CONFIG" || die "Headscale policy path is unset — tenants would not be isolated. See headscale/config/acl.hujson."
ok "ACL policy is wired up"

# ── 6. Services ────────────────────────────────────────────────────────────────────────────────
step "Starting services"
docker compose -f docker-compose.mongo.yml up -d
docker compose -f docker-compose.temporal.yml up -d
docker compose -f docker-compose.headscale.yml up -d
docker compose -f docker-compose.caddy.yml up -d
ok "Mongo, Temporal, Headscale and Caddy running"

# Nothing seeds the catalogues at server start any more, and this host never runs setup.sh — so
# without this a fresh VPS comes up with no tools, personas, packs or tree types. Idempotent: a
# re-run writes nothing when everything already matches.
step "Seeding catalogues"
npx tsx apps/backend/src/scripts/seed-all.ts
ok "Catalogues seeded"

step "Creating the management cluster"
bash scripts/ensure-cluster.sh || warn "ensure-cluster.sh reported a problem — check before provisioning"

# ── 7. systemd ─────────────────────────────────────────────────────────────────────────────────
# Without this the platform dies on reboot and every tenant loses the ability to provision.
step "Installing the systemd unit"
cat > /etc/systemd/system/nowrinkles.service <<UNIT
[Unit]
Description=No Wrinkles platform
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=${REPO_DIR}
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable nowrinkles.service
ok "nowrinkles.service enabled (start it once you have verified the build)"

# ── 8. Verify ──────────────────────────────────────────────────────────────────────────────────
step "Verifying"
sleep 5
if curl -sf -m 15 "https://${MESH_DOMAIN}/health" >/dev/null 2>&1; then
  ok "https://${MESH_DOMAIN} is serving with a valid certificate"
else
  warn "Headscale is not answering over TLS yet — Caddy may still be issuing. Check: docker logs nowrinkles-caddy"
fi

echo
echo "Next:"
echo "  1. systemctl start nowrinkles"
echo "  2. Join this node to its own mesh so it can reach tenant machines:"
echo "       docker exec provisioning-headscale headscale users create platform-root"
echo "       tailscale up --login-server=https://${MESH_DOMAIN} --advertise-tags=tag:platform"
echo "  3. Confirm it appears:  docker exec provisioning-headscale headscale nodes list"
echo "  4. Register the first account at https://${APP_DOMAIN} — the FIRST account ever created"
echo "     becomes admin and is the only one that can mint invite codes. Do this before sharing"
echo "     the URL with anyone."
echo
echo "Optional — Google/GitHub sign-in (email+password works without it):"
echo "  Register an OAuth app with these exact redirect URIs, then add the ids to"
echo "  ${ENV_FILE} and restart:"
echo "    Google : https://${APP_DOMAIN}/api/auth/google/callback"
echo "    GitHub : https://${APP_DOMAIN}/api/auth/github/callback"
echo "  Keys: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET."
echo "  Left unset, those buttons return 501 rather than falling back to the dev mock login."
