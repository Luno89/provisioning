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

echo "▶ Generating the four platform keys..."
for NAME in SESSION_KEY DATA_KEY PAYLOAD_KEY EGRESS_KEY; do
    VALUE=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s/^${NAME}=generate$/${NAME}=${VALUE}/" "$ENV_FILE"
    else
        sed -i "s/^${NAME}=generate$/${NAME}=${VALUE}/" "$ENV_FILE"
    fi
done

echo "✔ Environment file successfully created at: apps/backend/.env"
echo "✔ SESSION_KEY, DATA_KEY, PAYLOAD_KEY and EGRESS_KEY generated."
echo ""
echo "Note: The platform is fully operational in mock/warning modes for
Twilio 2FA, Google/GitHub Social Logins, and all cloud providers.
To configure real credentials (AWS, GCP, Azure, DigitalOcean, Twilio, OAuth),
simply open and edit the apps/backend/.env file.
========================================================================"
