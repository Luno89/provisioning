#!/bin/bash

# Multi-Cloud Provisioning Platform - First Time Setup Script
set -e

echo "🚀 Starting first-time setup..."

# 1. Check for Docker (Required for k3d)
if ! command -v docker &> /dev/null; then
    echo "❌ Error: Docker is not installed. Please install Docker to use local clusters (k3d)."
    exit 1
fi
echo "✅ Docker detected."

# 2. Create local bin directory
mkdir -p bin
export PATH=$(pwd)/bin:$PATH

# 3. Download Binaries if missing
echo "📦 Checking infrastructure binaries..."

# Terraform
if [ ! -f "bin/terraform" ]; then
    echo "📥 Downloading Terraform..."
    curl -fsSL https://releases.hashicorp.com/terraform/1.9.0/terraform_1.9.0_linux_amd64.zip -o terraform.zip
    unzip -o terraform.zip -d bin
    rm terraform.zip
fi

# k3d
if [ ! -f "bin/k3d" ]; then
    echo "📥 Downloading k3d..."
    curl -fsSL https://github.com/k3d-io/k3d/releases/download/v5.6.3/k3d-linux-amd64 -o bin/k3d
    chmod +x bin/k3d
fi

# Helm
if [ ! -f "bin/helm" ]; then
    echo "📥 Downloading Helm..."
    curl -fsSL https://get.helm.sh/helm-v3.15.1-linux-amd64.tar.gz -o helm.tar.gz
    tar -zxvf helm.tar.gz linux-amd64/helm --strip-components=1
    mv helm bin/
    rm -rf helm.tar.gz
fi

# kubectl
if [ ! -f "bin/kubectl" ]; then
    echo "📥 Downloading kubectl..."
    curl -fsSL "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" -o bin/kubectl
    chmod +x bin/kubectl
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

echo "✨ Setup complete! You can now run 'npm run dev' to start the platform."
