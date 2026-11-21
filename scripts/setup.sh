#!/bin/bash
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
    echo "Run npm run setup as yourself, not with sudo; on Linux run sudo bash scripts/setup-root.sh first."
    exit 1
fi

cd "$(dirname "$0")/.."
DETECTED_OS="$(uname -s)"

if [ "$DETECTED_OS" = "Darwin" ] && ! docker info >/dev/null 2>&1; then
    command -v brew >/dev/null 2>&1 || { echo "Install Homebrew (https://brew.sh) or Docker Desktop, then run npm run setup again."; exit 1; }
    command -v colima >/dev/null 2>&1 || brew install colima docker
    colima status >/dev/null 2>&1 || colima start
fi
if ! docker info >/dev/null 2>&1; then
    if [ "$DETECTED_OS" = "Linux" ] && id -nG "$(id -un)" | tr ' ' '\n' | grep -qx docker && [ -z "${KOALA_SETUP_IN_DOCKER_GROUP:-}" ]; then
        exec sg docker -c "KOALA_SETUP_IN_DOCKER_GROUP=1 bash '$(pwd)/scripts/setup.sh'"
    fi
    echo "Docker is not running or not yours to use. On Linux: sudo bash scripts/setup-root.sh"
    exit 1
fi
echo "Docker runs"

bash scripts/setup-binaries.sh
export PATH=$(pwd)/bin:$PATH

echo "Installing the workspaces' packages"
npm ci

echo "Fetching the Mongo the tests run, the version production pins"
MONGOMS_DOWNLOAD_DIR="$HOME/.cache/mongodb-binaries" MONGOMS_VERSION=8.0.38 node node_modules/mongodb-memory-server/postinstall.js

echo "Generating CDKTF's provider bindings"
(cd packages/cdktf-infra && npx cdktf get)

mkdir -p apps/backend/data
[ -f apps/backend/.env ] || cp apps/backend/.env.example apps/backend/.env
echo "Writing the platform keys apps/backend/.env lacks"
npm run -s keys -w apps/backend -- --write-env

echo ""
echo "Setup is done. npm run dev starts root, signs you up, joins this computer as your machine and puts Koala on it."
