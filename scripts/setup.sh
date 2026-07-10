#!/bin/bash

# Multi-Cloud Provisioning Platform - First Time Setup Script
set -e

echo "🚀 Starting first-time setup..."

# 1. Check/Install Docker (Required for k3d)
is_docker_running() {
    docker info &> /dev/null
}

if ! command -v docker &> /dev/null || ! is_docker_running; then
    echo "⚠️ Docker is either not installed or not running."
    
    DETECTED_OS="$(uname -s)"
    if [ "$DETECTED_OS" = "Darwin" ]; then
        echo "💻 macOS detected. Setting up Colima (open-source Docker runtime alternative)..."
        if ! command -v colima &> /dev/null; then
            if command -v brew &> /dev/null; then
                echo "📥 Installing Colima and Docker CLI via Homebrew..."
                brew install colima docker
            else
                echo "❌ Homebrew is not installed. Please install Homebrew (https://brew.sh) or Docker Desktop first."
                exit 1
            fi
        fi
        
        # Start Colima if not running
        if ! colima status &>/dev/null; then
            echo "🚀 Starting Colima container runtime..."
            colima start
        fi
    elif [ "$DETECTED_OS" = "Linux" ]; then
        echo "🐧 Linux detected. Setting up Docker CE (open-source)..."
        if ! command -v docker &> /dev/null; then
            if [ "$EUID" -eq 0 ] || command -v sudo &>/dev/null; then
                echo "📥 Installing Docker CE using official script..."
                curl -fsSL https://get.docker.com | sh
                if command -v systemctl &>/dev/null; then
                    sudo systemctl start docker || true
                fi
            else
                echo "💡 Please install Docker CE using the official script:"
                echo "   curl -fsSL https://get.docker.com | sh"
                exit 1
            fi
        else
            echo "🚀 Attempting to start Docker daemon..."
            if command -v systemctl &>/dev/null; then
                sudo systemctl start docker || true
            elif command -v service &>/dev/null; then
                sudo service docker start || true
            else
                echo "❌ Could not start Docker daemon automatically. Please run: sudo systemctl start docker"
                exit 1
            fi
        fi
    else
        echo "❌ Unsupported OS for automatic Docker installation."
        exit 1
    fi
    
    # Wait a moment and verify
    echo "⏳ Waiting for Docker daemon to become responsive..."
    sleep 3
    if ! is_docker_running; then
        echo "❌ Error: Docker daemon is still not running. Please ensure your container runtime is active."
        exit 1
    fi
fi
echo "✅ Docker detected and running."

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

# Verify existing binaries are runnable for this platform, delete if invalid
for tool in terraform k3d helm kubectl docker-compose; do
    if [ -f "bin/$tool" ]; then
        local_runnable=1
        case "$tool" in
            terraform) if ./bin/terraform -version &>/dev/null; then local_runnable=0; fi ;;
            k3d)       if ./bin/k3d --version &>/dev/null; then local_runnable=0; fi ;;
            helm)      if ./bin/helm version --client &>/dev/null; then local_runnable=0; fi ;;
            kubectl)   if ./bin/kubectl version --client &>/dev/null; then local_runnable=0; fi ;;
            docker-compose) if ./bin/docker-compose version &>/dev/null; then local_runnable=0; fi ;;
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
    curl -fsSL "https://releases.hashicorp.com/terraform/1.9.0/terraform_1.9.0_${OS}_${ARCH}.zip" -o terraform.zip
    unzip -o terraform.zip -d bin
    rm terraform.zip
fi

# k3d
if [ ! -f "bin/k3d" ]; then
    echo "📥 Downloading k3d..."
    curl -fsSL "https://github.com/k3d-io/k3d/releases/download/v5.6.3/k3d-${OS}-${ARCH}" -o bin/k3d
    chmod +x bin/k3d
fi

# Helm
if [ ! -f "bin/helm" ]; then
    echo "📥 Downloading Helm..."
    curl -fsSL "https://get.helm.sh/helm-v3.15.1-${OS}-${ARCH}.tar.gz" -o helm.tar.gz
    tar -zxvf helm.tar.gz "${OS}-${ARCH}/helm"
    mv "${OS}-${ARCH}/helm" bin/
    rm -rf "${OS}-${ARCH}" helm.tar.gz
fi

# Helm Linux (for container copying)
if [ "$OS" != "linux" ]; then
    if [ ! -f "bin/helm-linux" ]; then
        echo "📥 Downloading Linux Helm (for container copying)..."
        curl -fsSL "https://get.helm.sh/helm-v3.15.1-linux-${ARCH}.tar.gz" -o helm-linux.tar.gz
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
    curl -fsSL "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/${OS}/${ARCH}/kubectl" -o bin/kubectl
    chmod +x bin/kubectl
fi

# docker-compose
if [ ! -f "bin/docker-compose" ]; then
    echo "📥 Downloading docker-compose..."
    DC_ARCH="$ARCH"
    if [ "$ARCH" = "amd64" ]; then DC_ARCH="x86_64"; fi
    if [ "$ARCH" = "arm64" ]; then DC_ARCH="aarch64"; fi
    curl -fsSL "https://github.com/docker/compose/releases/download/v2.29.1/docker-compose-${OS}-${DC_ARCH}" -o bin/docker-compose
    chmod +x bin/docker-compose
fi

echo "✅ Binaries ready."

# 4. Install NPM Dependencies
echo "npm 📦 Installing dependencies..."
# Clean up any conflicting node_modules before a fresh install
rm -rf node_modules apps/frontend/node_modules apps/backend/node_modules packages/cdktf-infra/node_modules
npm install

# 5. Generate CDKTF Provider Bindings
echo "⚙️ Generating CDKTF provider bindings..."
cd packages/cdktf-infra
# Dependencies already installed by workspace root install
npx cdktf get
cd ../..

# 6. Initialize Backend
echo "🛠️ Initializing backend..."
mkdir -p apps/backend/data
if [ ! -f "apps/backend/.env" ]; then
    if [ -f "apps/backend/.env.example" ]; then
        cp apps/backend/.env.example apps/backend/.env
        echo "📝 Created default .env for backend."
    else
        echo "PORT=3001" > apps/backend/.env
        echo "📝 Created new .env for backend."
    fi
fi

# 7. Setup k3d Cluster (if not already running)
echo "🔄 Setting up k3d cluster..."
if ! ./bin/k3d cluster list 2>/dev/null | grep -q "provisioning-lunorica"; then
    ./scripts/cluster.sh create provisioning-lunorica
else
    echo "  ▶  cluster provisioning-lunorica already running — skipping creation"
fi
NGINX_DATA_DIR="$(pwd)/apps/backend/data/nginx"
mkdir -p "$NGINX_DATA_DIR/conf.d"

# Create main nginx.conf if not exists
if [ ! -f "$NGINX_DATA_DIR/nginx.conf" ]; then
    cat << 'EOF' > "$NGINX_DATA_DIR/nginx.conf"
user  nginx;
worker_processes  auto;

error_log  /var/log/nginx/error.log notice;
pid        /var/run/nginx.pid;

events {
    worker_connections  1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

    log_format  main  '$remote_addr - $remote_user [$time_local] "$request" '
                      '$status $body_bytes_sent "$http_referer" '
                      '"$http_user_agent" "$http_x_forwarded_for"';

    access_log  /var/log/nginx/access.log  main;

    sendfile        on;
    keepalive_timeout  65;

    include /etc/nginx/conf.d/*.conf;
}
EOF
fi

# Create default site config if not exists
if [ ! -f "$NGINX_DATA_DIR/conf.d/default.conf" ]; then
    cat << 'EOF' > "$NGINX_DATA_DIR/conf.d/default.conf"
server {
    listen 80 default_server;
    server_name _;

    location / {
        default_type text/plain;
        return 200 "Multi-Cloud Provisioning Platform Nginx Proxy Active\n";
    }
}
EOF
fi

# Start docker container
if docker ps -a --format '{{.Names}}' | grep -Eq "^provisioner-nginx$"; then
    echo "Removing existing provisioner-nginx container..."
    docker rm -f provisioner-nginx
fi

PORT_80_IN_USE=0
if command -v lsof &>/dev/null; then
    if lsof -i :80 -sTCP:LISTEN -t &>/dev/null; then PORT_80_IN_USE=1; fi
elif command -v nc &>/dev/null; then
    if nc -z 127.0.0.1 80 &>/dev/null; then PORT_80_IN_USE=1; fi
elif command -v ss &>/dev/null; then
    if ss -tln | grep -q -E "(^|:)(80|0\.0\.0\.0:80) "; then PORT_80_IN_USE=1; fi
elif command -v netstat &>/dev/null; then
    if netstat -an | grep -E "(:|\.)80 " | grep -qi "listen" &>/dev/null; then PORT_80_IN_USE=1; fi
fi

PORT_MAP="80:80"
if [ "$PORT_80_IN_USE" -eq 1 ]; then
    echo "⚠️ Port 80 is already in use on the host. Falling back to port 8000."
    PORT_MAP="8000:80"
fi

echo "Starting provisioner-nginx container on port ${PORT_MAP%%:*}..."
docker run -d \
    --name provisioner-nginx \
    --restart always \
    -p "$PORT_MAP" \
    -v "$NGINX_DATA_DIR/nginx.conf:/etc/nginx/nginx.conf:ro" \
    -v "$NGINX_DATA_DIR/conf.d:/etc/nginx/conf.d:rw" \
    nginx:alpine

# Deploy the worker image into the k3d cluster
if [ -f Dockerfile.worker ]; then
    echo "🔄 Building worker Docker image..."
    docker build -t deployworker.sh -f Dockerfile.worker .
    
    echo "📥 Importing worker Docker image into k3d..."
    ./bin/k3d image import deployworker.sh -c provisioning-lunorica
    
    echo "⛵ Deploying worker pod into cluster..."
    ./bin/kubectl apply -f k8s/worker-sa.yaml --context k3d-provisioning-lunorica 2>/dev/null || true
    ./bin/kubectl apply -f k8s/worker-deployment.yaml --context k3d-provisioning-lunorica
fi

echo "✨ Setup complete! You can now run 'npm run dev' to start the platform."

