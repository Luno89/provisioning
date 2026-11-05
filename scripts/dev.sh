#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV_DATA="${ROOT}/apps/backend/data/dev"
KUBECONFIG_FILE=/etc/rancher/k3s/k3s.yaml
IMAGE=127.0.0.1:5000/nowrinkles/app:dev

if [ "$(id -u)" -eq 0 ]; then
  echo "Run npm run dev as yourself, not with sudo; it asks for sudo itself only where it must."
  exit 1
fi

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

say "Root's services: Temporal, Mongo, Headscale, the registry"
bash "${ROOT}/scripts/ensure-temporal.sh"
bash "${ROOT}/scripts/ensure-mongo.sh"
bash "${ROOT}/scripts/ensure-headscale.sh"
docker compose -f "${ROOT}/docker-compose.registry.yml" up -d >/dev/null

if [ -x /usr/local/bin/k3s-provisioning-lunorica-uninstall.sh ]; then
  say "Removing the k3s dev ran before (provisioning-lunorica); this computer gets a machine's k3s instead"
  sudo /usr/local/bin/k3s-provisioning-lunorica-uninstall.sh
fi

if systemctl is-active --quiet firewalld && ! firewall-cmd --zone=trusted --list-sources 2>/dev/null | grep -qw 10.42.0.0/16; then
  say "Letting the pods on this computer reach root on it (firewalld: 10.42.0.0/16 trusted)"
  sudo firewall-cmd --permanent --zone=trusted --add-source=10.42.0.0/16 >/dev/null
  sudo firewall-cmd --reload >/dev/null
fi

mkdir -p "${DEV_DATA}"
IMAGE_INPUTS="$(cat "${ROOT}/Dockerfile" "${ROOT}/package-lock.json" "${ROOT}/docker/entrypoint.sh" | sha256sum | cut -d' ' -f1)"
if [ "$(cat "${DEV_DATA}/image.sha" 2>/dev/null || true)" != "${IMAGE_INPUTS}" ] || ! curl -fsS -o /dev/null "http://127.0.0.1:5000/v2/nowrinkles/app/manifests/dev" -H 'Accept: application/vnd.docker.distribution.manifest.v2+json'; then
  say "Building the image Koala's pods start from (its tools; they run this checkout)"
  docker build -t "${IMAGE}" "${ROOT}"
  docker push "${IMAGE}"
  printf '%s\n' "${IMAGE_INPUTS}" > "${DEV_DATA}/image.sha"
fi

say "Root and the hub"
npx tsx "${ROOT}/apps/backend/src/scripts/dev-root.ts"
set -a; . "${DEV_DATA}/urls.env"; set +a
with_env() { echo "set -a; . '${DEV_DATA}/$1.env'; set +a; exec $2"; }

for port in 3002 3003 5173 5175 5176; do
  for pid in $(lsof -ti ":${port}" 2>/dev/null || true); do
    if [ "$(ps -o uid= -p "$pid" | tr -d ' ')" = "$(id -u)" ]; then kill "$pid" 2>/dev/null || true; fi
  done
done

if [ "${COUPLING_LIVE:-}" = 1 ]; then
  export COUPLING_LIVE_DIR="${ROOT}/tests/.coupling/live"
  rm -rf "${COUPLING_LIVE_DIR}"
  mkdir -p "${COUPLING_LIVE_DIR}/raw"
  export NODE_V8_COVERAGE="${COUPLING_LIVE_DIR}/raw"
  export NODE_OPTIONS="--enable-source-maps --import ${ROOT}/tests/coupling/live-hook.mjs ${NODE_OPTIONS:-}"
fi

ROOT_NAMES="root,root-worker,hub,web-root,web-hub"
ROOT_PROCESSES=(
  "bash -c \"$(with_env root 'npm run dev -w apps/backend')\""
  "bash -c \"$(with_env root 'npm run dev:worker -w apps/backend')\""
  "bash -c \"$(with_env hub 'npm run dev -w apps/backend')\""
  "KOALA_BACKEND=http://localhost:3002 VITE_API_BASE=/api npm run dev -w apps/frontend -- --port 5175 --strictPort --host 0.0.0.0"
  "KOALA_BACKEND=http://localhost:3003 VITE_API_BASE=/api npm run dev -w apps/frontend -- --port 5176 --strictPort --host 0.0.0.0"
)

if [ ! -f "${XDG_CONFIG_HOME:-$HOME/.config}/koala/machine.json" ]; then
  say "This computer joins your account as a machine, and Koala is put on it"
  npx concurrently --names "${ROOT_NAMES}" "${ROOT_PROCESSES[@]}" > "${DEV_DATA}/first-start.log" 2>&1 &
  STARTING=$!
  trap 'kill ${STARTING} 2>/dev/null || true' EXIT
  npx tsx "${ROOT}/apps/backend/src/scripts/dev-machine.ts"
  kill "${STARTING}" 2>/dev/null || true
  wait "${STARTING}" 2>/dev/null || true
  trap - EXIT
fi

say "Dev runs as production does"
echo "  Root:        ${ROOT_WEB}   (sign in here)"
echo "  Your Koala:  ${INSTANCE_WEB}   (pods on this computer's k3s, running this checkout under a watcher)"
echo "  Hub:         ${HUB_WEB}"

exec npx concurrently --kill-others-on-fail \
  --names "${ROOT_NAMES},web-koala,machine,koala" \
  --prefix-colors "red,yellow,white,gray,gray,cyan,green,blue" \
  "${ROOT_PROCESSES[@]}" \
  "KOALA_BACKEND=http://127.0.0.1:30320 VITE_API_BASE=/api npm run dev -w apps/frontend -- --port 5173 --strictPort" \
  "npx tsx ${ROOT}/apps/backend/src/scripts/dev-machine.ts" \
  "k3s kubectl --kubeconfig ${KUBECONFIG_FILE} -n nowrinkles logs -f --prefix --all-containers --max-log-requests 20 -l app.kubernetes.io/part-of=nowrinkles-instance"
