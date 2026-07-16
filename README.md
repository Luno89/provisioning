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

## ⚡ Quick Start

```bash
# 1. Clone and enter the repository
git clone <your-repository-url>
cd provisioning

# 2. First-time setup (installs deps, downloads binaries, starts k3d cluster, builds worker)
npm run setup

# 3. Start the platform
npm run dev
```

Open **[http://localhost:5173](http://localhost:5173)** in your browser.

The `setup` script handles: npm dependencies, CDKTF provider bindings, pre-bundled binary downloads, k3d management cluster creation, Nginx proxy container, worker pod deployment, and environment configuration.

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

---

## 🧹 Useful Commands

| Command | Description |
|---|---|
| `npm run dev` | Start all services (backend, frontend, host worker, cluster worker) |
| `npm run clean-dev` | Kill all dev processes, delete k3d clusters, clean DBs |
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
- **JSON file database** — Read-modify-write pattern; may have race conditions under high concurrency.
- **Port 80 or 8000 required** — The Nginx proxy container binds to port 80 (falls back to 8000 if occupied).
