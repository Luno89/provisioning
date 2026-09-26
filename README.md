# No Wrinkles

Spin up Kubernetes clusters — locally, on a VPS you rent, or on hardware you already own — deploy
applications to them with public access, and hand software work to agents that plan it, build it
in a sandbox and have it judged before it counts. **No port forwarding, no dynamic DNS.**

Machines can attach over a WireGuard mesh (Headscale), dialling outward, so a box behind your home
NAT works the same as a rented VPS.

---

## 🏗️ Architecture

```
React UI (Vite :5173) ──▶ Express API (:3001) ──▶ Temporal ──┬─▶ host worker     cluster provisioning (k3d / Hetzner / remote)
        ▲                       │                            ├─▶ cluster worker  app deploys, disk resizes (CDKTF, Helm, kubectl)
        └──── Socket.IO ────────┤                            ├─▶ engine worker   agent runs, tools, sandboxes, grove runs
                                │                            └─▶ stream worker   model calls (in the backend process)
                                ▼
                             MongoDB

Management cluster (native k3s on Linux, k3d on macOS):
  Gitea (repos + image registry) · Infisical (+ secrets operator) · Verdaccio (npm mirror)
  agent sandboxes · your apps, if you deploy there
```

- **Backend** (`apps/backend/`) — REST API, Socket.IO events, the service layer, the three Temporal workers
- **Frontend** (`apps/frontend/`) — React 19 + Vite; react-query for server state, zustand for UI state
- **Agent engine** (`packages/agent-engine/`, `packages/engine-core/`) — procedures (graphs of nodes), personas, the tool catalogue and the model-call path; the backend hosts it in `apps/backend/src/engine-host/`
- **CDKTF** (`packages/cdktf-infra/`) — Terraform bindings for clusters and per-app stacks
- **Local agent** (`apps/local-agent/`) — runs on your own machine, dials out, and executes engine work there
- **MongoDB** — all persistence. `apps/backend/data/` holds only logs, nginx config and generated secrets for the local services

Everything under `/api` needs a session: email/password, GitHub or Google OAuth (a local mock flow
when their client IDs are unset), optional SMS 2FA.

---

## 🛠️ Prerequisites

1. **Node.js 20+**
2. **Docker** — Linux: installed by `scripts/setup-root.sh`; macOS: Colima via Homebrew in `npm run setup`

`k3d`, `kubectl`, `helm` and `terraform` are pre-bundled in `bin/`.

---

## ⚡ Quick Start

```bash
git clone <your-repository-url>
cd provisioning

# Linux only, the single sudo step: Docker CE, GPU container toolkit (a no-op without a GPU),
# native k3s, trust for the self-hosted Gitea registry, and a scoped passwordless-sudo rule.
sudo bash scripts/setup-root.sh

# As your normal user — never with sudo: deps, CDKTF bindings, binaries, the management cluster.
npm run setup

# Every time: ensures the cluster, Gitea, Verdaccio, Temporal, MongoDB, Headscale and Infisical,
# then runs the backend, frontend and all three workers.
npm run dev
```

Open **http://localhost:5173**.

> [!IMPORTANT]
> The workers do not hot-reload. The backend runs under `tsx watch`, but after changing anything a
> worker imports (activities, workflows, engine code) restart `npm run dev`. `npm run test:alive`
> flags workers that are older than the source.

---

## 🧭 What you can do

### Clusters
**Clusters** → create one on **k3d** (local, containers), **Hetzner** (a VPS the platform rents with
your token) or **remote** (any machine you can SSH into; k3s is bootstrapped over SSH). Each cluster
gets Traefik and Prometheus/Grafana/Loki; k3d clusters also get the Infisical secrets operator. Cloud providers without
credentials run in *mock cloud mode* on local k3d. The **VPS Catalog** compares rentable machines.

### Applications
**Applications** → deploy to a cluster and expose it publicly (Nginx + Localtunnel).

| Kind | Apps |
|---|---|
| Business & web | Odoo, WordPress, Nextcloud, Papra |
| Media | Jellyfin, Plex, Navidrome, Kavita, Immich, Audiobookshelf |
| Home & games | Home Assistant, Palworld |
| AI | vLLM, TabbyAPI, Open WebUI, SearXNG, Crawl4AI, TEI, Hermes agent |
| Data & infra | MinIO, Qdrant, Quickwit, Verdaccio, Temporal |
| Your own code | **gitapp** — a project's repo, built by the pipeline into the Gitea registry and deployed |

Odoo, WordPress, Nextcloud and Audiobookshelf have Helm and native variants; the rest are native
manifests.

### Projects and code
A **project** is a Gitea repo with a build pipeline (kaniko in the cluster). A successful build
can be promoted to a gitapp deployment on the project's target cluster.

### Secrets
Secrets never pass through a model. An agent that needs one calls `request_secret` with the
environment variable name and gets back only `secret://<project>/<KEY>`. You enter the value on a
card in the chat or on the tree page; it goes straight into Infisical. At deploy, the operator on
the target cluster syncs the project's secrets into `<namespace>-secrets`, which the app reads as
environment variables — and a value changed in Infisical reaches the running pod without a
redeploy.

### Koala, Grove and the agent engine
- **Koala** (chat) — talks the work through. When there is work, it hands it to the **planner**,
  which proposes a plan as a card: a tree of branches, leaves (checkable goals) and tasks. Nothing
  is created until you approve it.
- **Projects → trees (Grove)** — approving creates the tree, one sandbox for the whole tree,
  `PLAN.md` and a brief per leaf. **Run** works the ready leaves in parallel, a git worktree each;
  a separate judge checks each claimed leaf against its goal. Failed leaves get replan proposals
  you approve; a claim the judge cannot settle waits for you.
- **Studio** — edit procedures on a canvas, personas (prompt, model, sampling, tools, what they may
  change) and tools (a command template plus what it installs).
- **Evals** — Level 1 (does the model pick the right tool) and Level 2 (scenarios with real
  handlers) against any configured endpoint.
- **Memories** — what agents have learned, recalled into later runs.
- **Engine** — live view of runs and their node traces.

Models come from your deployed vLLM and TabbyAPI apps and from LLM providers added under **Cloud
Accounts**; the default model is chosen in **Settings**.

---

## 🎮 GPU (vLLM, TabbyAPI)

GPU workloads run only on the always-on management cluster (native k3s on Linux): k3d's nested
containerd cannot pass devices through, so k3d clusters are never GPU-enabled.

1. Install the NVIDIA driver (or ROCm for AMD).
2. `sudo bash scripts/setup-gpu.sh` — detects the distro, installs and configures the container
   toolkit, verifies passthrough. Idempotent. (`setup-root.sh` already runs this step.)
3. On the first GPU deploy the platform installs the NVIDIA or AMD device plugin DaemonSet
   (`k8s/gpu-device-plugin/`), waits for it, then applies the stack.

Verify: `nvidia-smi` and `docker run --rm --gpus all ubuntu nvidia-smi`.

---

## 🧪 Testing

| Level | Command | What it proves |
|---|---|---|
| Alive | `npm run test:alive` | Docker, management cluster, K8s API, Temporal, workers — and that workers run current code |
| Unit | `npm run test:unit` | Typecheck plus every workspace's Vitest suite (~80s) |
| Worker | `npm run test:worker` | Real Temporal workflows (provision, deploy) without the browser |
| E2E | `npm run test:e2e` | Playwright through the UI (`tests/e2e.spec.ts`) |
| Infra | `npm run test:infra:integration` | Provision → verify → destroy a cluster |
| Remote | `npm run test:remote-integration` | A disposable QEMU VM provisioned as a `remote` cluster over SSH (~10–15 min) |
| Grove | `npm run test:tree-sandbox`, `test:plan-adoption`, `test:leaf-worktrees` | The tree sandbox, plan adoption and worktrees against the real cluster |
| Live model | `npm run test:planner-live`, `test:grove-live` | The planner and a grove run on a real model |
| Secrets | `npm run test:secrets-live`, `test:secret-injection-live` | Koala asks for a secret, the card vaults it, nothing leaks; the value reaches a deployed pod and a rotation follows |

`npm test` runs alive → unit → E2E; `npm run test:all` adds the slow integration suites.
Live-model tests use the configured endpoint — TabbyAPI by default; paid endpoints only when you
choose them.

**E2E monitor:** with `npm run dev` running, `npx tsx scripts/e2e-monitor.ts` shows clusters,
logs, pods, workflows and workers live, and can run, terminate and clean up tests.

---

## 🧹 Commands

| Command | |
|---|---|
| `npm run dev` | Ensure the local services, then run backend, frontend and the three workers |
| `npm run clean-dev` | Kill dev processes, delete k3d clusters, clean the databases. On Linux it also stops and wipes native k3s; re-run `sudo bash scripts/setup-root.sh && npm run setup` after |
| `npm run setup` | First-time setup |
| `npm run lint` | Frontend ESLint |
| `npm run typecheck` | Every workspace |

---

## 📁 Structure

```
apps/
  backend/        Express API, routes/ → services/ → lib/, Temporal workers, engine-host/
  frontend/       React dashboard: components/, api/ (the only place URLs live), stores/, types/
  local-agent/    Runs engine work on your own machine
packages/
  agent-engine/   Procedures, nodes, personas, tool catalogue, model calls
  engine-core/    Tool contracts and execution, shared with the local agent
  harness-types/  Shapes shared by backend and frontend
  context-engine/ Context assembly
  cdktf-infra/    Cluster and app stacks, one construct per app
bin/              Pre-bundled k3d, kubectl, helm, terraform
k8s/              In-cluster worker and GPU device plugins
scripts/          Setup, ensure-* for each local service, cleanup, root-node deploys
tests/            Playwright spec and the integration / live suites
docs/             The Grove migration tracker and its ledger
```

Contributor rules (import conventions, layering, what counts as done) are in `CLAUDE.md`.

---

## ⚠️ Known limitations

- **Localtunnel** is a free service: slow to connect, a warning page on each visit, and URLs change
  when the backend restarts.
- **A gitapp cannot deploy to a k3d cluster yet** — the host's Docker pulls from the Gitea registry
  over HTTPS and the registry speaks HTTP. Deploy gitapps to the management cluster.
- **Secrets on remote and cloud clusters** — they cannot reach Infisical yet, so a project that
  declares secrets is refused there with the reason.
- **Port 80 or 8000** — the Nginx proxy binds port 80, falling back to 8000.

---

## 🔄 Temporal sync

MongoDB stays in sync with Temporal two ways: `trackWorkflow()` polls each workflow every 5s
(retrying transient Temporal errors up to 12 times), and a reconciliation loop every 30s checks
clusters in intermediate states against Temporal and updates their progress from the logs.
Temporal is optional for the backend to start; it falls back to database polling.
