#!/bin/sh
set -eu

KOALA_URL="__KOALA_URL__"
CODE=""
YES=0
FOLDER=""
SERVICE=1

while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1 ;;
    --folder) FOLDER="$2"; shift ;;
    --no-service) SERVICE=0 ;;
    --url) KOALA_URL="$2"; shift ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) CODE="$1" ;;
  esac
  shift
done

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
die() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
ask() {
  [ "$YES" = 1 ] && return 0
  printf '  %s [y/N] ' "$1"
  read -r answer < /dev/tty || answer=""
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}
json() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

[ -n "$CODE" ] || die "usage: curl -fsSL ${KOALA_URL}/machine.sh | sh -s -- <code from My Machines>"
[ "$(id -u)" != 0 ] || die "run this as yourself, not root: the agents it finds are yours"
have curl || die "curl is needed"
have tar || die "tar is needed"

say "Checking this machine"
have node || die "Node.js 20 or newer is needed: install it from https://nodejs.org (or with nvm), then run this again"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js $(node -v) is too old: Koala's machine agent needs 20 or newer"
have npm || die "npm is needed alongside Node.js"
NODE_BIN=$(command -v node)
ok "Node.js $(node -v)"

if [ -z "$FOLDER" ]; then
  FOLDER="$HOME/koala"
  if [ "$YES" != 1 ]; then
    printf '  Which folder may Koala work in? [%s] ' "$FOLDER"
    read -r answer < /dev/tty || answer=""
    [ -n "$answer" ] && FOLDER="$answer"
  fi
fi
case "$FOLDER" in "~"*) FOLDER="$HOME${FOLDER#\~}" ;; esac
mkdir -p "$FOLDER"
FOLDER=$(cd "$FOLDER" && pwd)
ok "Koala works in $FOLDER, and nowhere else"

say "Joining ${KOALA_URL}"
JOIN_ENV=$(mktemp)
trap 'rm -f "$JOIN_ENV"' EXIT
HOST=$(hostname 2>/dev/null || uname -n)
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/koala/machine.json"
REPLACES=""
[ -f "$CONFIG" ] && REPLACES=$(node -e 'try { process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).token || "")) } catch {}' "$CONFIG")
OS="$(uname -s) $(uname -m)"
HTTP_CODE=$(printf '%s' "{\"code\":\"$(json "$CODE")\",\"hostname\":\"$(json "$HOST")\",\"rootDir\":\"$(json "$FOLDER")\",\"os\":\"$(json "$OS")\",\"replaces\":\"$(json "$REPLACES")\"}" \
  | curl -sS -o "$JOIN_ENV" -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data-binary @- \
  "${KOALA_URL}/api/machines/join?format=env")
[ "$HTTP_CODE" = 200 ] || die "Koala refused this machine (${HTTP_CODE}): $(cat "$JOIN_ENV")"
. "$JOIN_ENV"
rm -f "$JOIN_ENV"
ok "this machine is ${HOST} on your account"

if [ -n "${MESH_LOGIN_SERVER:-}" ]; then
  say "Joining your private network"
  if ! have tailscale; then
    ask "Tailscale isn't installed. Koala reaches this machine through it, privately. Install it?" || die "stopped: this machine needs the private network to take work"
    curl -fsSL https://tailscale.com/install.sh | sh
  fi
  sudo tailscale up --login-server="$MESH_LOGIN_SERVER" --authkey="$MESH_AUTH_KEY" --accept-dns=false
  ok "on the private network as $(tailscale ip -4 | head -n1)"
fi

say "Installing the machine agent"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/koala/machine"
mkdir -p "$DATA_DIR"
curl -fsSL "${KOALA_URL}/api/machines/agent.tgz" | tar -xzf - -C "$DATA_DIR"
(cd "$DATA_DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null)
ok "installed in $DATA_DIR"

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/koala"
mkdir -p "$CONFIG_DIR"
CONFIG="$CONFIG_DIR/machine.json"
(
  umask 077
  cat > "$CONFIG" <<EOF
{
  "backendUrl": "$(json "$KOALA_BACKEND_URL")",
  "token": "$(json "$KOALA_DEVICE_TOKEN")",
  "deviceId": "$(json "$KOALA_DEVICE_ID")",
  "rootDir": "$(json "$KOALA_ROOT_DIR")",
  "temporalAddress": "$(json "$KOALA_TEMPORAL_ADDRESS")",
  "temporalNamespace": "$(json "$KOALA_TEMPORAL_NAMESPACE")"
}
EOF
)
chmod 600 "$CONFIG"
ok "its settings are in $CONFIG, readable only by you"

START="\"$NODE_BIN\" \"$DATA_DIR/agent.mjs\""
if [ "$SERVICE" = 1 ] && [ "$(uname -s)" = Linux ] && have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
  say "Starting it, now and whenever you log in"
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/koala-machine.service" <<EOF
[Unit]
Description=Koala machine agent
After=network-online.target

[Service]
ExecStart=$NODE_BIN $DATA_DIR/agent.mjs
WorkingDirectory=$FOLDER
Environment=PATH=$PATH
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable koala-machine.service >/dev/null 2>&1
  systemctl --user restart koala-machine.service
  ok "running as the koala-machine service (journalctl --user -u koala-machine to read it)"
  if loginctl enable-linger "$(id -un)" >/dev/null 2>&1; then
    ok "it starts when this machine starts, without you logging in"
  else
    echo "  It runs while you are logged in. To keep it running after a restart without logging in: sudo loginctl enable-linger $(id -un)"
  fi
elif [ "$SERVICE" = 1 ] && [ "$(uname -s)" = Darwin ]; then
  say "Starting it, now and whenever you log in"
  PLIST="$HOME/Library/LaunchAgents/dev.koala.machine.plist"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.koala.machine</string>
  <key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$DATA_DIR/agent.mjs</string></array>
  <key>WorkingDirectory</key><string>$FOLDER</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/koala-machine.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/koala-machine.log</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  ok "running as dev.koala.machine (its log is ~/Library/Logs/koala-machine.log)"
else
  say "Start it with"
  echo "  $START"
fi

say "Done"
echo "  This machine shows on My Machines in a moment, with the coding agents it found."
