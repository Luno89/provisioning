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

# Auto-generate a secure random 256-bit JWT secret
echo "▶ Generating secure random JWT_SECRET..."
JWT_RANDOM_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# Replace template secret with the generated key
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS sed syntax
    sed -i '' "s/JWT_SECRET=your_jwt_secret_here/JWT_SECRET=$JWT_RANDOM_SECRET/g" "$ENV_FILE"
else
    # Linux sed syntax
    sed -i "s/JWT_SECRET=your_jwt_secret_here/JWT_SECRET=$JWT_RANDOM_SECRET/g" "$ENV_FILE"
fi

echo "✔ Environment file successfully created at: apps/backend/.env"
echo "✔ Secure JWT_SECRET automatically generated."
echo ""
echo "Note: The platform is fully operational in mock/warning modes for
Twilio 2FA, Google/GitHub Social Logins, and all cloud providers.
To configure real credentials (AWS, GCP, Azure, DigitalOcean, Twilio, OAuth),
simply open and edit the apps/backend/.env file.
========================================================================"
