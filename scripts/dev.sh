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

STEP=0
say() { STEP=$((STEP + 1)); printf '\n\033[1m[%s] %s\033[0m\n' "${STEP}" "$1"; }
quietly() {
  local log pid code shown=0 width lines
  log="$(mktemp)"
  "$@" >"${log}" 2>&1 &
  pid=$!
  if [ -t 1 ]; then
    width=$(( $(tput cols 2>/dev/null || echo 100) - 6 ))
    while kill -0 "${pid}" 2>/dev/null; do
      lines="$(tr '\r' '\n' < "${log}" | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | grep -v '^[[:space:]]*$' | tail -n 8 | cut -c1-"${width}" || true)"
      [ "${shown}" -gt 0 ] && printf '\033[%dA\033[J' "${shown}"
      shown=0
      if [ -n "${lines}" ]; then
        printf '%s\n' "${lines}" | sed 's/^/    \x1b[2m/; s/$/\x1b[0m/'
        shown=$(printf '%s\n' "${lines}" | wc -l)
      fi
      sleep 0.3
    done
    [ "${shown}" -gt 0 ] && printf '\033[%dA\033[J' "${shown}"
  fi
  code=0
  wait "${pid}" || code=$?
  if [ "${code}" -ne 0 ]; then
    tr '\r' '\n' < "${log}" | tail -n 40
    rm -f "${log}"
    return "${code}"
  fi
  rm -f "${log}"
}

say "Terraform's providers, pinned, in the mirror every stack installs from"
quietly sh "${ROOT}/scripts/terraform-providers.sh" "${ROOT}/bin/terraform-providers"
echo "  ready"

say "Root's services: Temporal, Mongo, Headscale, the registry"
quietly bash "${ROOT}/scripts/ensure-temporal.sh"
quietly bash "${ROOT}/scripts/ensure-mongo.sh"
quietly bash "${ROOT}/scripts/ensure-headscale.sh"
quietly "${ROOT}/bin/docker-compose" -f "${ROOT}/docker-compose.registry.yml" up -d
echo "  running"

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
if [ "$(cat "${DEV_DATA}/image.sha" 2>/dev/null || true)" != "${IMAGE_INPUTS}" ] || ! curl -fsS -o /dev/null "http://127.0.0.1:5000/v2/nowrinkles/app/manifests/dev" -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json'; then
  say "Building the image Koala's pods start from (its tools; they run this checkout)"
  quietly docker build -t "${IMAGE}" "${ROOT}"
  quietly docker push "${IMAGE}"
  echo "  built and pushed to root's registry"
  printf '%s\n' "${IMAGE_INPUTS}" > "${DEV_DATA}/image.sha"
fi

say "Root and the hub"
npx tsx "${ROOT}/apps/backend/src/scripts/dev-root.ts"
echo "  settings in ${DEV_DATA}"
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
  "bash -c \"$(with_env root 'npm run -s dev -w apps/backend')\""
  "bash -c \"$(with_env root 'npm run -s dev:worker -w apps/backend')\""
  "bash -c \"$(with_env hub 'npm run -s dev -w apps/backend')\""
  "KOALA_BACKEND=http://localhost:3002 VITE_API_BASE=/api npm run -s dev -w apps/frontend -- --logLevel warn --port 5175 --strictPort --host 0.0.0.0"
  "KOALA_BACKEND=http://localhost:3003 VITE_API_BASE=/api npm run -s dev -w apps/frontend -- --logLevel warn --port 5176 --strictPort --host 0.0.0.0"
)

MACHINE_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/koala/machine.json"
if ! node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).rootUrl === process.argv[2] ? 0 : 1)' "${MACHINE_FILE}" "${ROOT_WEB}" 2>/dev/null; then
  say "This computer joins your account as a machine, and Koala is put on it"
  npx concurrently --names "${ROOT_NAMES}" "${ROOT_PROCESSES[@]}" > "${DEV_DATA}/first-start.log" 2>&1 &
  STARTING=$!
  trap 'kill ${STARTING} 2>/dev/null || true' EXIT
  npx tsx "${ROOT}/apps/backend/src/scripts/dev-machine.ts"
  kill "${STARTING}" 2>/dev/null || true
  wait "${STARTING}" 2>/dev/null || true
  trap - EXIT
fi

COLLECTOR_IP="$(k3s kubectl --kubeconfig "${KUBECONFIG_FILE}" -n monitoring get service otel-collector -o 'jsonpath={.spec.clusterIP}' 2>/dev/null || true)"
if [ -n "${COLLECTOR_IP}" ] && [ "${COLLECTOR_IP}" != None ]; then
  export OTEL_EXPORTER_OTLP_ENDPOINT="http://${COLLECTOR_IP}:4318"
  TELEMETRY_LINE="root's and the hub's telemetry go to the collector on this computer's k3s, beside your Koala's (Grafana: koala_role root and hub)"
else
  TELEMETRY_LINE="your Koala has not installed its collector yet; root's and the hub's telemetry go to it from the next start"
fi

say "Dev runs as production does; the logs of root, the hub and your Koala's pods follow"
echo "  ${TELEMETRY_LINE}"
echo "  Root:        ${ROOT_WEB}   (sign in here)"
echo "  Your Koala:  ${INSTANCE_WEB}   (pods on this computer's k3s, running this checkout under a watcher)"
echo "  Hub:         ${HUB_WEB}"

exec npx concurrently --kill-others-on-fail \
  --names "${ROOT_NAMES},web-koala,machine,koala" \
  --prefix-colors "red,yellow,white,gray,gray,cyan,green,blue" \
  "${ROOT_PROCESSES[@]}" \
  "KOALA_BACKEND=http://127.0.0.1:30320 VITE_API_BASE=/api npm run -s dev -w apps/frontend -- --logLevel warn --port 5173 --strictPort" \
  "npx tsx ${ROOT}/apps/backend/src/scripts/dev-machine.ts" \
  "until k3s kubectl --kubeconfig ${KUBECONFIG_FILE} -n nowrinkles logs -f --prefix --all-containers --max-log-requests 20 -l 'app.kubernetes.io/part-of=nowrinkles-instance,app.kubernetes.io/component in (backend,worker-host,worker-cluster,worker-engine)'; do sleep 5; done"
