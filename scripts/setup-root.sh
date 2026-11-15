#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "This needs root once: sudo bash scripts/setup-root.sh"
  exit 1
fi
if [ "$(uname -s)" != "Linux" ]; then
  echo "Nothing to do as root on $(uname -s): npm run setup installs Docker through Colima for you."
  exit 0
fi
PERSON="${SUDO_USER:-}"
if [ -z "$PERSON" ] || [ "$PERSON" = root ]; then
  echo "Run it with sudo as yourself (sudo bash scripts/setup-root.sh), so Docker is yours to use."
  exit 1
fi

DOCKER_VERSION=29.9.0
DOCKER_INSTALL_COMMIT=ada7a567e59b3935bd601bb21e422da50e80e376
DOCKER_INSTALL_SHA256=2b102d809152ea157a59f171319f489d971273b2d26dd7e9a6d1d737ce89289d

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker CE ${DOCKER_VERSION}"
  installer="$(mktemp)"
  curl -fsSL "https://raw.githubusercontent.com/docker/docker-install/${DOCKER_INSTALL_COMMIT}/install.sh" -o "$installer"
  echo "${DOCKER_INSTALL_SHA256}  ${installer}" | sha256sum -c --quiet - \
    || { rm -f "$installer"; echo "Docker's install script is not the one Koala pins (its sha256 differs); nothing was installed"; exit 1; }
  VERSION="$DOCKER_VERSION" sh "$installer"
  rm -f "$installer"
fi
systemctl enable --now docker
docker info >/dev/null || { echo "Docker did not start: systemctl status docker"; exit 1; }
echo "Docker runs"

if ! id -nG "$PERSON" | tr ' ' '\n' | grep -qx docker; then
  usermod -aG docker "$PERSON"
  echo "${PERSON} may use Docker (npm run setup picks it up without logging out)"
fi

if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --zone=trusted --add-source=10.42.0.0/16 >/dev/null
  firewall-cmd --reload >/dev/null
  echo "firewalld lets this computer's pods reach root on it (10.42.0.0/16 trusted)"
fi

rm -f /etc/sudoers.d/provisioning-platform

echo ""
echo "Done. Next, as yourself: npm run setup"
