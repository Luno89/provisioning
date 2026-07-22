# 🚀 Multi-Cloud Provisioning Platform

A local-first platform to spin up Kubernetes clusters and deploy production-ready applications (Odoo, WordPress, Nextcloud, Audiobookshelf) with instant public internet access — **no port forwarding or dynamic DNS configuration required**.

---

## 🏗️ Architecture

```
┌─────────────┐     ┌──────────────┐     ┌───────────────┐     ┌──────────────┐
│  React UI   │────▶│  Express API  │────▶│  Temporal.io   │────▶│    CDKTF      │
│  (Vite 5173)│     │  (Node 3001) │     │  (Workflows)   │     │  (Terraform)  │
└─────────────┘     └──────────────┘     └───────────────┘     └──────┬───────┘
                                                                     │
                              ┌──────────────────────────────────────┤
                              ▼                                      ▼
                    ┌─────────────────┐                   ┌─────────────────┐
                    │  k3d (local)    │                   │  AWS / GCP / DO │
                    │  Docker cluster │                   │  (Cloud VPCs)   │
                    └────────┬────────┘                   └─────────────────┘
                             │
                    ┌────────▼────────┐
                    │  Nginx Proxy    │◀── Localtunnel (public URLs)
                    │  (Docker)       │
                    └─────────────────┘
```

- **Express backend** (`apps/backend/`) — REST API, Socket.IO real-time events, service layer for kubectl/helm/docker operations
- **React frontend** (`apps/frontend/`) — Single-page dashboard with wizard-driven cluster provisioning and app deployment
- **Temporal.io** (optional) — Workflow orchestration for long-running provisioning and deployment tasks
- **CDKTF** (`packages/cdktf-infra/`) — Infrastructure-as-code via Terraform bindings for Kubernetes resources
- **Nginx + Localtunnel** — Reverse proxy container with public tunnel URLs for exposed applications
- **JSON file DB** — Lightweight persistence at `apps/backend/data/`

---

## 🛠️ Prerequisites

1. **Node.js (v20 or higher)**
   - **Mac**: `brew install node`
   - **Linux**: Install via [nvm](https://github.com/nvm-sh/nvm) or your package manager

2. **Docker** (required for k3d clusters)
   - **Mac**: The setup script auto-installs **Colima** (open-source) via Homebrew
   - **Linux**: The setup script auto-installs **Docker CE** via the official install script

> [!NOTE]
> All infrastructure binaries (`k3d`, `kubectl`, `helm`, `terraform`, `docker-compose`) are pre-bundled in the `bin/` directory. No manual installation needed.

> [!TIP]
> For full workflow orchestration (Temporal.io), also run: `docker compose -f docker-compose.temporal.yml up`

---

## 🎮 GPU Support (vLLM)

To deploy vLLM workloads, your host needs a GPU driver **and** a container runtime that can pass GPUs to Docker containers. The platform auto-installs the in-cluster GPU device plugin on first vLLM deploy — you only need to configure the host.

### NVIDIA GPUs

**1. Install NVIDIA driver** (if not already):
```bash
# Fedora / RHEL / Nobara
sudo dnf install nvidia-driver nvidia-driver-cuda

# Debian / Ubuntu
sudo apt install nvidia-driver
```

**2. Install NVIDIA Container Toolkit** (auto):
```bash
sudo bash scripts/setup-gpu.sh
```
The script auto-detects your distro, adds the NVIDIA repo, installs the toolkit, configures Docker, restarts Docker, and verifies GPU passthrough. Includes retry logic for network failures. Idempotent — safe to run multiple times.

**Or manually**:
```bash
# Add NVIDIA repo (works on Fedora, RHEL, CentOS, Nobara)
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo \
  | sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo

# Debian / Ubuntu
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
sudo apt-get update

# Install the toolkit
sudo dnf install -y nvidia-container-toolkit   # Fedora / RHEL
# or: sudo apt-get install -y nvidia-container-toolkit   # Debian / Ubuntu

# Configure Docker to use NVIDIA runtime
sudo nvidia-ctk runtime configure --runtime=docker

# Restart Docker
sudo systemctl restart docker
```

**3. Verify**:
```bash
nvidia-smi                                    # Driver working
docker run --rm --gpus all ubuntu nvidia-smi  # Docker can see GPU
```

### AMD GPUs (ROCm)

**1. Run the setup script** (detects AMD, shows instructions):
```bash
sudo bash scripts/setup-gpu.sh
```
The script will detect your AMD GPU and display distro-specific ROCm installation instructions.

**Manual setup**:
```bash
# Follow official ROCm installation guide for your distro:
# https://rocm.docs.amd.com/en/latest/deploy/linux/quick_start.html
```

**2. Install ROCm Container Toolkit**:
```bash
# ROCm container runtime setup varies by distro.
# See: https://rocm.docs.amd.com/en/latest/deploy/linux/container.html
```

**3. Verify**:
```bash
rocminfo                                     # ROCm driver working
docker run --rm --device /dev/kfd --device /dev/dri rocm/dev-ubuntu:latest rocminfo
```

> [!NOTE]
> AMD GPU support requires x86_64 (amd64) architecture. The device plugin includes `nodeSelector: kubernetes.io/arch: amd64`.

### What happens at deploy time

When you deploy a vLLM app on a k3d cluster:

1. **Host check** — The platform verifies the GPU container toolkit is installed. If missing, the deploy fails with a clear error message.
2. **Device plugin** — The appropriate DaemonSet (NVIDIA or AMD) is installed into the cluster automatically.
3. **Ready wait** — The platform waits up to 60s for the device plugin pod to become ready.
4. **Deploy** — CDKTF applies the vLLM stack. The K8s scheduler now sees `nvidia.com/gpu` or `amd.com/gpu` as available resources.

If the host toolkit is not configured, you'll see an error like:
> NVIDIA Container Toolkit is not configured for Docker. Install it and run: `sudo nvidia-ctk runtime configure --runtime=docker`, then restart Docker.

---

## ⚡ Quick Start

```bash
# 1. Clone and enter the repository
git clone <your-repository-url>
cd provisioning

# 2. Linux only: one-time root-level install (Docker CE + native k3s, not started yet).
#    Never run scripts/setup.sh itself with sudo — see below.
sudo bash scripts/setup-root.sh

# 3. Linux + NVIDIA GPU only: configure GPU passthrough BEFORE first start (see below for why
#    the order matters) — safe/no-op on hosts with no GPU.
sudo bash scripts/setup-gpu.sh

# 4. First-time setup (deps, binaries, worker, AND brings the management cluster up) — WITHOUT sudo
npm run setup

# 5. Start the platform
npm run dev
```

Open **[http://localhost:5173](http://localhost:5173)** in your browser.

The `setup` script handles: npm dependencies, CDKTF provider bindings, pre-bundled binary downloads, Nginx proxy container, worker pod deployment, environment configuration, and — the step that actually finishes provisioning the management cluster — starting it and waiting for it to be `Ready` (macOS: k3d, created fresh here; Linux: the native k3s instance installed by `setup-root.sh`). It must be run as your normal user, not root — it does `npm install` and creates files that need to stay owned by you; running it under `sudo` leaves `node_modules` root-owned and breaks the dev server. `setup-gpu.sh` needs to run *before* this step on Linux GPU hosts: it writes the containerd config controlling GPU passthrough, which is only read when the cluster starts — running it after would mean an extra manual restart to pick up the change.

---

## 📦 Supported Applications

| Application | Helm Strategy | Native Strategy |
|---|---|---|
| **Odoo** | `odoo` | `odoo-native` |
| **WordPress** | `wordpress` | `wordpress-native` |
| **Nextcloud** | `nextcloud` | `nextcloud-native` |
| **Audiobookshelf** | `audiobookshelf` | `audiobookshelf-native` |

- **Helm** — Deploys via official Helm charts with configurable values
- **Native** — Deploys raw Kubernetes manifests (Deployments, Services, PVCs) for full control

Additionally, the platform auto-provisions:
- **Monitoring** — Prometheus + Grafana (via `kube-prometheus-stack` Helm chart)
- **Ingress** — Traefik dashboard accessible from the Services panel

---

## 🌐 How to Deploy and Expose Your First App

1. **Create a Cluster**:
   - Click **Create Cluster** on the dashboard.
   - Pick a name (e.g., `my-local-cluster`), choose **k3d** as the provider, and click **Create**.
   - A drawer will slide open showing real-time setup logs. Wait for it to show `running`.

2. **Deploy an Application**:
   - Click **Deploy App** in the upper right.
   - Select your newly created cluster.
   - Set a name (e.g., `odoo-local`), choose the application type, and select a strategy (**Native** or **Helm**).
   - Click **Initiate Deployment**. You will see the deployment logs stream live.

3. **Expose It to the Internet**:
   - Once running, go to the application card on your dashboard.
   - Click the **Expose Application** button.
   - A public address (e.g., `https://xxxx-xxxx-xx.loca.lt`) will appear.
   - Tunnels auto-restore on backend restart — no need to re-expose.

4. **Access the Application**:
   - Click the public link.
   - **Localtunnel Warning Screen**: Since this is a public link, localtunnel displays a phishing warning.
   - Type in your current public IP address (google "what is my IP" or check the dashboard helper text) and click **Click to Continue**.

5. **Customize the Path (Optional)**:
   - Use the **Target Route Path** input to append a sub-path (e.g., `/odoo` for Odoo's login page). Saves automatically on blur or pressing Enter.

6. **Service Dashboards**:
   - Navigate to the **Services** sidebar panel to access Prometheus, Grafana, and Traefik dashboards via iframe — no port-forwarding needed.

7. **Custom Nginx Configs**:
   - Use the **Nginx Router** wizard to generate custom reverse-proxy server blocks for VPN IPs or advanced routing. Edit `nginx.conf` directly in the built-in editor.

---

## 🧪 Testing

The test suite uses a layered escalation approach:

| Level | Command | What it does |
|---|---|---|
| **1. Alive** | `npm run test:alive` | Checks Docker, k3d cluster, K8s API, Temporal health, worker pod |
| **2. Unit** | `npm run test:unit` | Vitest tests for frontend components + backend services (~5s) |
| **3. Worker** | `npm run test:worker` | Temporal workflow isolation tests (K3d, CDKTF, Helm, Kubectl) |
| **4. E2E** | `npm run test:e2e` | Playwright browser tests driving the React UI |
| **Infra** | `npm run test:infra:integration` | Full cluster provision → verify → destroy (~5 min) |

```bash
npm run test          # alive → unit → e2e (full pipeline)
npm run test:unit     # backend + frontend unit tests only
npm run test:e2e      # Playwright browser tests only
```

Single workspace:
```bash
npm run test -w apps/backend    # backend unit tests
npm run test -w apps/frontend   # frontend unit tests
```

### E2E Monitor

Interactive dashboard for debugging E2E tests in real-time:

```bash
npm run dev &                    # start dev stack first
npx tsx scripts/e2e-monitor.ts   # launch monitor
```

The monitor shows:
- MongoDB clusters with status and progress step
- Live log tail from the active provisioning cluster
- K8s pod status for the active cluster
- Temporal workflow status
- k3d cluster list
- Worker health (host + cluster)

Menu keys: `0-9, a` run specific tests, `r` runs all, `t` terminates workflows, `c` cleans MongoDB, `d` full teardown, `q` quit.

---

## 🧹 Useful Commands

| Command | Description |
|---|---|
| `npm run dev` | Start all services (backend, frontend, host worker, cluster worker) |
| `npm run clean-dev` | Kill all dev processes, delete k3d clusters, clean DBs. **Linux**: also stops the native k3s management cluster and wipes its state — removal only, same as the k3d cleanup above it. Doesn't reinstall or bring anything back up; re-run `sudo bash scripts/setup-gpu.sh && npm run setup` afterward (that's what provisions it — see Quick Start). |
| `npm run setup` | First-time setup (deps, binaries, cluster, worker) |
| `npm run test` | Run full test suite (alive → unit → e2e) |
| `npm run test:unit` | Run unit tests only |
| `npm run test:e2e` | Run Playwright E2E tests only |

Worker-specific (for debugging):
```bash
npm run dev:worker -w apps/backend         # host-side Temporal worker
npm run dev:worker:cluster -w apps/backend  # in-cluster Temporal worker
```

---

## 📁 Project Structure

```
provisioning/
├── apps/
│   ├── backend/          Express API, services, Temporal workers
│   │   ├── src/index.ts        Server entry point
│   │   ├── src/services/       InfrastructureService, ClusterService, AppService, etc.
│   │   ├── src/worker-host.ts  Host-side Temporal worker
│   │   └── src/worker-cluster.ts  In-cluster Temporal worker
│   └── frontend/         React 19 + Vite dashboard
│       └── src/App.tsx         Main UI component
├── packages/
│   └── cdktf-infra/      CDKTF infrastructure stacks
│       ├── main.ts             Cluster and App stack entry
│       └── constructs/         Per-app constructs (native + Helm)
├── bin/                  Pre-bundled k3d, kubectl, helm, terraform
├── k8s/                  K8s manifests for in-cluster worker pod
├── scripts/              Setup, cluster management, cleanup scripts
└── docker-compose.temporal.yml  Temporal.io Docker Compose
```

npm workspaces: `apps/*`, `packages/*`

---

## ⚠️ Known Limitations

- **Localtunnel is a free service** — Public URLs may be slow to connect, and the phishing warning appears on every visit. URLs change on backend restart.
- **No authentication** — All API routes are open. Not intended for production use.
- **k3d for local development** — The management cluster (`provisioning-lunorica`) is k3d-based. Cloud providers (AWS, GCP, DigitalOcean) are supported but require CLI credentials.
- **Port 80 or 8000 required** — The Nginx proxy container binds to port 80 (falls back to 8000 if occupied).

## 🔄 Temporal Sync

MongoDB stays in sync with Temporal via two mechanisms:

1. **`trackWorkflow()` polling** — polls every 5s per workflow. On transient Temporal errors, retries up to 12 times before giving up.
2. **Background reconciliation loop** — runs every 30s. Scans all clusters in intermediate states, checks Temporal workflow status directly, and updates MongoDB if the workflow has completed but the DB wasn't updated. Also parses log files to update the `progress` field on clusters.
