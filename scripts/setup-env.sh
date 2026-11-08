#!/usr/bin/env bash
set -euo pipefail

# Locate absolute path of repo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/apps/backend/.env"
EXAMPLE_FILE="$REPO_ROOT/apps/backend/.env.example"

echo "=================================================================="
echo "          IANTHE Environment Initialization                       "
echo "=================================================================="

if [ -f "$ENV_FILE" ]; then
    echo "▶ Existing .env file found at: apps/backend/.env"
    read -p "Do you want to overwrite it with defaults? (y/N) " -r response
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        echo "▶ Preserving existing configuration. Setup complete."
        exit 0
    fi
fi

echo "▶ Generating new configuration from .env.example..."
cp "$EXAMPLE_FILE" "$ENV_FILE"
# setup-root.sh runs before this script and may have created the target
# directory as root — keep the file owned by the current user.
chown "$(id -u):$(id -g)" "$ENV_FILE"

echo "▶ Generating the five platform keys and root's identity key..."
(cd "$REPO_ROOT" && npm run -s keys -w apps/backend -- --write-env)

echo "✔ Environment file successfully created at: apps/backend/.env"
echo ""
echo "Note: Twilio 2FA and Google/GitHub sign-in stay off until their
credentials are set in apps/backend/.env.
========================================================================"
