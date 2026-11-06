#!/bin/sh
set -eu

KUBERNETES_VERSION=2.38.0
KUBERNETES_SHA256_LINUX_AMD64=d39861aa21077f1bc899bc53e7233262e530ba8a3a2d737449b100daeb303e4d
KUBERNETES_SHA256_LINUX_ARM64=63fab47349852d7802fb032e4f2b6a101ee1ce34b62557a9ad0f0f0f5b6ecfdc
KUBERNETES_SHA256_DARWIN_AMD64=5136e51765d6a0b9e4dbcc3b38821e9736bd2136cf15e9aac11668f22db117d2
KUBERNETES_SHA256_DARWIN_ARM64=1be998e67206f7cfc4ffe77c01a09ac91ce725de0abaec9030b22c0a832af44f
HELM_VERSION=2.17.0
HELM_SHA256_LINUX_AMD64=88644260090aa621e7e8083585c468c8dd5e09a3c01a432fb05da5c4623af940
HELM_SHA256_LINUX_ARM64=a248f650d174a883b32c5b94f9e725f4057e623b00f171936dcdcc840fad0b3e
HELM_SHA256_DARWIN_AMD64=129345c82359837bb3f0070ce4891ec232697052f7d5ccf61d43d818912cf5f3
HELM_SHA256_DARWIN_ARM64=aa498c1f1ab93be5c8fbf6d48af51dc6ef0f10b2ea88d67bcb9f02d1d80d3930
HCLOUD_VERSION=1.68.0
HCLOUD_SHA256_LINUX_AMD64=b825f6500592d30004b6de8547ca1fa7841e16da0571cee8a67782cb84ec65cd
HCLOUD_SHA256_LINUX_ARM64=a04f8e12811e000657151cd6eed5eb80ae1042b8123bfea28343147ceda40f96
HCLOUD_SHA256_DARWIN_AMD64=73855025066ec55230559296b5c92d441b1b6dc2ce27a1102ab1e17f60cdcf0e
HCLOUD_SHA256_DARWIN_ARM64=164012cca257951da2870e9a0a0eb0be2ebde26fd27e30081c8d7e8729467a6e

MIRROR="${1:?usage: terraform-providers.sh <mirror folder>}"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) echo "Terraform's providers are pinned for amd64 and arm64, not $(uname -m)" >&2; exit 1 ;;
esac
PLATFORM="${OS}_${ARCH}"
KEY="$(echo "$PLATFORM" | tr '[:lower:]' '[:upper:]')"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

provider() {
  namespace="$1" type="$2" version="$3" sha="$4" url="$5"
  place="$MIRROR/registry.terraform.io/$namespace/$type/$version/$PLATFORM"
  if [ -f "$place.sha256" ] && [ "$(cat "$place.sha256")" = "$sha" ]; then return 0; fi
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  curl -fsSL "$url" -o "$work/provider.zip"
  if [ "$(sha256_of "$work/provider.zip")" != "$sha" ]; then
    echo "$url is not the file Koala pins (its sha256 differs); nothing was installed" >&2
    exit 1
  fi
  mkdir -p "$work/unpacked"
  unzip -q "$work/provider.zip" -d "$work/unpacked"
  mkdir -p "$(dirname "$place")"
  rm -rf "$place" "$place.sha256"
  mv "$work/unpacked" "$place"
  chmod -R a+rX "$place"
  echo "$sha" > "$place.sha256"
  rm -rf "$work"
  trap - EXIT
}

pinned() { eval "echo \"\${${1}_SHA256_${KEY}:?no pinned $1 provider for $PLATFORM}\""; }

provider hashicorp kubernetes "$KUBERNETES_VERSION" "$(pinned KUBERNETES)" \
  "https://releases.hashicorp.com/terraform-provider-kubernetes/${KUBERNETES_VERSION}/terraform-provider-kubernetes_${KUBERNETES_VERSION}_${PLATFORM}.zip"
provider hashicorp helm "$HELM_VERSION" "$(pinned HELM)" \
  "https://releases.hashicorp.com/terraform-provider-helm/${HELM_VERSION}/terraform-provider-helm_${HELM_VERSION}_${PLATFORM}.zip"
provider hetznercloud hcloud "$HCLOUD_VERSION" "$(pinned HCLOUD)" \
  "https://github.com/hetznercloud/terraform-provider-hcloud/releases/download/v${HCLOUD_VERSION}/terraform-provider-hcloud_${HCLOUD_VERSION}_${PLATFORM}.zip"
