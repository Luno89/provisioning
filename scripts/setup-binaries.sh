#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

# 2. Create local bin directory
mkdir -p bin
export PATH=$(pwd)/bin:$PATH

# 3. Detect OS & Architecture
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
    x86_64)       ARCH="amd64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *)
        echo "❌ Error: Unsupported architecture $ARCH"
        exit 1
        ;;
esac

if [ "$OS" != "linux" ] && [ "$OS" != "darwin" ]; then
    echo "❌ Error: Unsupported operating system $OS"
    exit 1
fi

KUBECTL_VERSION=v1.36.2
KUBECTL_SHA256_LINUX_AMD64=1e9045ec32bea85da43de85f0065358529ea7c7a152eca78154fba5b58c27d82
KUBECTL_SHA256_LINUX_ARM64=c957eb8c4bea27a3bb35b269edd9082e27f027f7b76b20b5bf4afebc726c6d3e
KUBECTL_SHA256_DARWIN_AMD64=ce6c5e55cd17559e87e4fb5e73ebbbc2511bcf2b695d7a40c1b1461a9817d4b3
KUBECTL_SHA256_DARWIN_ARM64=4408c85c83fd3a31adaa555bdf3c7a6c81f74b19449a9060ba31ab91926f023d
RCLONE_VERSION=v1.75.2
RCLONE_SHA256_LINUX_AMD64=349ac8fba6ff65d6247043f1750cdcb518ec5d500ef91463a10d37c0ccdf3702
RCLONE_SHA256_LINUX_ARM64=7e1e8d69654941b7b7df84ee74c5f7fb09cce7d5496947fb7bf16b55ff427d10
RCLONE_SHA256_DARWIN_AMD64=574e1f31cf1c464e5fb0325cb66fcbdeaf1efa1802bd9b17f13c256fd74b6561
RCLONE_SHA256_DARWIN_ARM64=610ab7d48615135dfc60b763858b11a426a0d3d1160c1bb76fb0ae6011b02edd
TERRAFORM_SHA256_LINUX_AMD64=ab1358e73a81096bbe04201ef403a32e0765c5f6e360692d170d32d0889a4871
TERRAFORM_SHA256_LINUX_ARM64=f5c0a49b482c008a6afd2248c08ca919e599c1154a850ff94809f4a85c86eb3b
TERRAFORM_SHA256_DARWIN_AMD64=b69196c831d6315b6e79178c96a66365d724cf4b922ad4a9763cd970aeeecd45
TERRAFORM_SHA256_DARWIN_ARM64=b7701c42a9b69524cfe79f0928d48ec4d648bc5e08794df12e8b41b56a0a395c
K3D_SHA256_LINUX_AMD64=69f434b5a326eddafff6062a1b439d1c7a78a1ee93a91a9f79872cf8e516327d
K3D_SHA256_LINUX_ARM64=5d2e556e26681474a4aa09b40e2e9880084e0caf63a049b045cb22cc3188de68
K3D_SHA256_DARWIN_AMD64=c377952a095af4a1683411b2d3ccee53affdcdb7763d2dfca9714a9ebb978f8c
K3D_SHA256_DARWIN_ARM64=c8b824684153488a4234214e2f7264035e66bf73d2d68828ce026cb9c59bfc23
HELM_SHA256_LINUX_AMD64=7b20e7791c04ea71e7fe0cbe11f1a8be4a55a692898b57d9db28f3b0c1d52f11
HELM_SHA256_LINUX_ARM64=b4c5519b18f01dd2441f5e09497913dc1da1a1eec209033ae792a8d45b9e0e86
HELM_SHA256_DARWIN_AMD64=5fdc60e090d183113f9fa0ae9dd9d12f0c1462b9ded286370f84e340f84bd676
HELM_SHA256_DARWIN_ARM64=4b04ede5ab9bb226c9b198c94ce12818f0b0e302193defd66970b45fc341f6e7
COMPOSE_SHA256_LINUX_AMD64=5ea89dd65d33912a83737d8a4bf070d5de534a32b8493a21fbefc924484786a9
COMPOSE_SHA256_LINUX_ARM64=7f0023ba726b90347e4ebc1d94ec5970390b8bddb86402c0429f163dca70d745
COMPOSE_SHA256_DARWIN_AMD64=170acf9a5754ec244904fb63494c50249ba4aea22d84c1fad9a9eeadc8c87c66
COMPOSE_SHA256_DARWIN_ARM64=b4a5b264ecddeeced9c14116e1b726c6529f286bea0a14325fb6436a4b35d7ec
TEMPORAL_CLI_VERSION=1.10.1
TEMPORAL_TEST_SERVER_VERSION=1.41.1
TEMPORAL_CLI_SHA256_LINUX_AMD64=4c1500e2ce2d4de136e5fe8852d9b7f82eb62f19b6b383b3e0c040519a9d20b1
TEMPORAL_CLI_SHA256_LINUX_ARM64=2f748e9411b37c9cabb57f1f08e37765388c12b5534432c7aea28b593df9145d
TEMPORAL_CLI_SHA256_DARWIN_AMD64=8ec6c513ad2177de4eb15d2cb17a4fe5070e6078afd7f80bdfcc37fae459d3c4
TEMPORAL_CLI_SHA256_DARWIN_ARM64=94f7f982b26438e8abbde6000ba471b694be6a2413b31f6162f87a9f9c48c738
TEMPORAL_TEST_SERVER_SHA256_LINUX_AMD64=f577ffaa80e775a854a68ef47768f97337ecdf4a3f16dfd8d51cb3aa73bd9056
TEMPORAL_TEST_SERVER_SHA256_LINUX_ARM64=8b9813a69405869953c7f2e7d9df013f4460a073b4f6b0efeb2b8b643cd71c7c
TEMPORAL_TEST_SERVER_SHA256_DARWIN_AMD64=0feca672941379cd92265e1b6ef99384915bbff7f3384fa0ce8ef9d4e5279778
TEMPORAL_TEST_SERVER_SHA256_DARWIN_ARM64=ab048e92e846e062adbebbb8e7c825f17bef1fa8d89c2bc2d1c419e775b68a22
PLATFORM_KEY="$(echo "${OS}_${ARCH}" | tr '[:lower:]' '[:upper:]')"

fetch_checked() {
    local url="$1" sha="$2" out="$3" got
    curl -fsSL "$url" -o "$out"
    if command -v sha256sum &>/dev/null; then got="$(sha256sum "$out" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$out" | cut -d' ' -f1)"; fi
    if [ "$got" != "$sha" ]; then
        rm -f "$out"
        echo "❌ ${url} is not the file Koala pins (its sha256 differs); nothing was installed"
        exit 1
    fi
}

# Verify existing binaries are runnable for this platform, delete if invalid
for tool in terraform k3d helm kubectl docker-compose rclone; do
    if [ -f "bin/$tool" ]; then
        local_runnable=1
        case "$tool" in
            terraform) if ./bin/terraform -version &>/dev/null; then local_runnable=0; fi ;;
            k3d)       if ./bin/k3d --version &>/dev/null; then local_runnable=0; fi ;;
            helm)      if ./bin/helm version --client &>/dev/null; then local_runnable=0; fi ;;
            kubectl)   if ./bin/kubectl version --client &>/dev/null; then local_runnable=0; fi ;;
            docker-compose) if ./bin/docker-compose version &>/dev/null; then local_runnable=0; fi ;;
            rclone)    if ./bin/rclone version &>/dev/null; then local_runnable=0; fi ;;
        esac
        if [ "$local_runnable" -ne 0 ]; then
            echo "⚠️ Existing bin/$tool is not runnable on this platform (wrong OS/Arch). Deleting to force re-download..."
            rm -f "bin/$tool"
            if [ "$tool" = "helm" ]; then rm -f "bin/helm-linux"; fi
        fi
    fi
done

echo "📦 Checking infrastructure binaries for ${OS}/${ARCH}..."

# Terraform
if [ ! -f "bin/terraform" ]; then
    echo "📥 Downloading Terraform..."
    TERRAFORM_SHA="TERRAFORM_SHA256_${PLATFORM_KEY}"
    fetch_checked "https://releases.hashicorp.com/terraform/1.9.0/terraform_1.9.0_${OS}_${ARCH}.zip" "${!TERRAFORM_SHA}" terraform.zip
    unzip -o terraform.zip -d bin
    rm terraform.zip
fi

# k3d
if [ ! -f "bin/k3d" ]; then
    echo "📥 Downloading k3d..."
    K3D_SHA="K3D_SHA256_${PLATFORM_KEY}"
    fetch_checked "https://github.com/k3d-io/k3d/releases/download/v5.6.3/k3d-${OS}-${ARCH}" "${!K3D_SHA}" bin/k3d
    chmod +x bin/k3d
fi

# Helm
if [ ! -f "bin/helm" ]; then
    echo "📥 Downloading Helm..."
    HELM_SHA="HELM_SHA256_${PLATFORM_KEY}"
    fetch_checked "https://get.helm.sh/helm-v3.15.1-${OS}-${ARCH}.tar.gz" "${!HELM_SHA}" helm.tar.gz
    tar -zxvf helm.tar.gz "${OS}-${ARCH}/helm"
    mv "${OS}-${ARCH}/helm" bin/
    rm -rf "${OS}-${ARCH}" helm.tar.gz
fi

# Helm Linux (for container copying)
if [ "$OS" != "linux" ]; then
    if [ ! -f "bin/helm-linux" ]; then
        echo "📥 Downloading Linux Helm (for container copying)..."
        HELM_LINUX_SHA="HELM_SHA256_LINUX_$(echo "$ARCH" | tr '[:lower:]' '[:upper:]')"
        fetch_checked "https://get.helm.sh/helm-v3.15.1-linux-${ARCH}.tar.gz" "${!HELM_LINUX_SHA}" helm-linux.tar.gz
        tar -zxvf helm-linux.tar.gz "linux-${ARCH}/helm"
        mv "linux-${ARCH}/helm" bin/helm-linux
        rm -rf "linux-${ARCH}" helm-linux.tar.gz
    fi
else
    cp -f bin/helm bin/helm-linux
fi

# kubectl
if [ ! -f "bin/kubectl" ]; then
    echo "📥 Downloading kubectl..."
    KUBECTL_SHA="KUBECTL_SHA256_${PLATFORM_KEY}"
    fetch_checked "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/${OS}/${ARCH}/kubectl" "${!KUBECTL_SHA}" bin/kubectl
    chmod +x bin/kubectl
fi

# docker-compose
if [ ! -f "bin/docker-compose" ]; then
    echo "📥 Downloading docker-compose..."
    DC_ARCH="$ARCH"
    if [ "$ARCH" = "amd64" ]; then DC_ARCH="x86_64"; fi
    if [ "$ARCH" = "arm64" ]; then DC_ARCH="aarch64"; fi
    COMPOSE_SHA="COMPOSE_SHA256_${PLATFORM_KEY}"
    fetch_checked "https://github.com/docker/compose/releases/download/v2.29.1/docker-compose-${OS}-${DC_ARCH}" "${!COMPOSE_SHA}" bin/docker-compose
    chmod +x bin/docker-compose
fi

# rclone (used by scripts/backup-to-drive.sh to sync Mongo/k3d-storage/secrets to Google Drive)
if [ ! -f "bin/rclone" ]; then
    echo "📥 Downloading rclone..."
    # rclone's own release naming predates the "darwin" convention other tools here use.
    RCLONE_OS="$OS"
    if [ "$OS" = "darwin" ]; then RCLONE_OS="osx"; fi
    RCLONE_SHA="RCLONE_SHA256_${PLATFORM_KEY}"
    fetch_checked "https://downloads.rclone.org/${RCLONE_VERSION}/rclone-${RCLONE_VERSION}-${RCLONE_OS}-${ARCH}.zip" "${!RCLONE_SHA}" rclone.zip
    unzip -oq rclone.zip -d rclone-tmp
    mv rclone-tmp/rclone-*/rclone bin/rclone
    chmod +x bin/rclone
    rm -rf rclone.zip rclone-tmp
fi

# Temporal: the dev server and the time-skipping test server the tests run, each named by its version so a new pin fetches anew
if [ ! -f "bin/temporal-${TEMPORAL_CLI_VERSION}" ]; then
    echo "📥 Downloading the Temporal dev server..."
    TEMPORAL_CLI_SHA="TEMPORAL_CLI_SHA256_${PLATFORM_KEY}"
    fetch_checked "https://github.com/temporalio/cli/releases/download/v${TEMPORAL_CLI_VERSION}/temporal_cli_${TEMPORAL_CLI_VERSION}_${OS}_${ARCH}.tar.gz" "${!TEMPORAL_CLI_SHA}" temporal-cli.tar.gz
    mkdir -p temporal-cli-tmp
    tar -xzf temporal-cli.tar.gz -C temporal-cli-tmp temporal
    mv temporal-cli-tmp/temporal "bin/temporal-${TEMPORAL_CLI_VERSION}"
    chmod +x "bin/temporal-${TEMPORAL_CLI_VERSION}"
    rm -rf temporal-cli.tar.gz temporal-cli-tmp
fi
if [ ! -f "bin/temporal-test-server-${TEMPORAL_TEST_SERVER_VERSION}" ]; then
    echo "📥 Downloading the Temporal test server..."
    TEST_SERVER_OS="$OS"
    if [ "$OS" = "darwin" ]; then TEST_SERVER_OS="macOS"; fi
    TEMPORAL_TEST_SERVER_SHA="TEMPORAL_TEST_SERVER_SHA256_${PLATFORM_KEY}"
    TEST_SERVER_NAME="temporal-test-server_${TEMPORAL_TEST_SERVER_VERSION}_${TEST_SERVER_OS}_${ARCH}"
    fetch_checked "https://github.com/temporalio/sdk-java/releases/download/v${TEMPORAL_TEST_SERVER_VERSION}/${TEST_SERVER_NAME}.tar.gz" "${!TEMPORAL_TEST_SERVER_SHA}" temporal-test-server.tar.gz
    mkdir -p temporal-test-server-tmp
    tar -xzf temporal-test-server.tar.gz -C temporal-test-server-tmp "${TEST_SERVER_NAME}/temporal-test-server"
    mv "temporal-test-server-tmp/${TEST_SERVER_NAME}/temporal-test-server" "bin/temporal-test-server-${TEMPORAL_TEST_SERVER_VERSION}"
    chmod +x "bin/temporal-test-server-${TEMPORAL_TEST_SERVER_VERSION}"
    rm -rf temporal-test-server.tar.gz temporal-test-server-tmp
fi

echo "📥 Terraform's providers, pinned, into a mirror every stack installs from..."
sh scripts/terraform-providers.sh bin/terraform-providers

echo "✅ Binaries ready."
