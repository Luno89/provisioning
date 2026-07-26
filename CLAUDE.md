# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Multi-cloud provisioning platform (local-first): spin up Kubernetes clusters (k3d locally, or AWS/GCP/Azure/DO) and deploy apps (Odoo, WordPress, Nextcloud, Audiobookshelf, vLLM, Open WebUI) with public internet access via Nginx + Localtunnel — no port forwarding needed.

```
React UI (Vite :5173) → Express API (:3001) → Temporal.io (workflows) → CDKTF (Terraform) → k3d / AWS / GCP / DO
```

npm workspaces: `apps/*`, `packages/*`.

## Commands

```bash
npm run setup        # bootstrap: deps, CDKTF bindings, pre-bundled binaries, k3d cluster, worker pod, env
npm run dev          # ensure k3d+temporal+mongo → concurrently: backend, frontend, host-worker, cluster-worker
npm run clean-dev    # kill all dev processes, delete k3d clusters, clean DBs (scripts/cleanup-all.sh)

npm run test         # test:unit → test:e2e:sync (alive check → unit → tests/e2e.spec.ts via Playwright)
npm run test:all     # test → test:infra:integration → test:remote-integration → test:unit:vpn
npm run test:unit    # test:unit:frontend && test:unit:backend (Vitest, both under 5s)
npm run test:alive   # scripts/alive.sh — Docker/k3d/K8s API/Temporal/worker pod health, fails fast with fix hints
npm run test:worker  # tsx tests/worker-isolated.ts — runs real Temporal workflows without browser/webserver
npm run test:e2e     # test:alive → Playwright against e2e/ directory (skips unit preflight)
npm run test:infra:integration    # full cluster provision → verify → destroy, ~5 min (tests/infra-integration.ts)
npm run test:remote-integration   # boots a disposable QEMU VM, provisions it as a provider:'remote' cluster over
                                   # real SSH, verifies kubectl + deploys a real app, tears down VM+cluster — proves
                                   # the distributed-systems plan's Phase 2 (SSH k3s bootstrap) end-to-end, ~10-15 min.
                                   # Needs qemu-kvm/cloud-utils/genisoimage + /dev/kvm (tests/remote-host-integration.ts)
```

Note: there are two separate Playwright suites — `tests/e2e.spec.ts` (run by `npm test` via `test:e2e:sync`) and the `e2e/` directory (run by `npm run test:e2e`). Check which one a change needs before assuming coverage.

Per-workspace scripts (`test`, `lint`, `dev`, `dev:worker`, `dev:worker:cluster`) run the standard
way: `npm run <script> -w apps/backend`. See each workspace's `package.json` for what they invoke.

Run a single test file: `npx vitest run <path>` from the relevant workspace dir, or `npx playwright test <file>` from repo root.

### E2E Monitor

Interactive dashboard for debugging E2E runs in real time:
```bash
npm run dev &                    # start dev stack first
npx tsx scripts/e2e-monitor.ts
```
Refreshes every 2s: MongoDB cluster status/progress, live log tail, K8s pod status, Temporal workflow status, k3d cluster list, worker health. Menu: `0-9,a` run a specific Playwright test, `r` run all, `t` terminate workflows, `c` clean Mongo test collections, `d` full teardown, `l` last log lines, `q` quit.

## Repo structure

| Path | What |
|---|---|
| `apps/backend/src/index.ts` | Express server entry — `bootstrap()` inits DB, all services, JWT auth middleware, socket.io, ~30 inline routes (no Router) |
| `apps/backend/src/lib/db-interface.ts` | `Database` interface + `createDatabase()` — MongoDB unless `NODE_ENV=test` and not E2E, in which case `MemoryDB` |
| `apps/backend/src/lib/mongo-db.ts` / `memory-db.ts` | MongoDB native driver impl / in-memory mock for unit tests |
| `apps/backend/src/lib/auth.ts`, `crypto.ts` | JWT sign/verify, password hashing; AES-256-GCM encrypt/decrypt/mask for stored secrets |
| `apps/backend/src/lib/credential-resolver.ts` | Resolution chain for cloud creds: user-stored → `process.env` → mock mode |
| `apps/backend/src/services/` | Service layer (see below) |
| `apps/backend/src/workflows/` + `activities/` | Temporal.io workflow/activity definitions |
| `apps/backend/src/worker-host.ts` | Host-side Temporal worker — cluster provisioning/destruction activities |
| `apps/backend/src/worker-cluster.ts` | In-cluster Temporal worker — app deploy/destroy/resize activities; reads K8s service account when in-cluster |
| `apps/frontend/src/main.tsx` / `App.tsx` | React entry / ~1800-line monolith with most of the UI in one component |
| `apps/frontend/src/components/` | Extracted pieces: `Login`, `CloudAccounts`, `AnsiText` (ANSI log rendering) |
| `packages/cdktf-infra/main.ts` | CDKTF entry — stack type selected via `STACK_TYPE=cluster\|app` env var |
| `packages/cdktf-infra/constructs/` | Per-app CDKTF constructs, each with a Helm variant and a `-native` (raw K8s manifest) variant |
| `bin/` | Pre-downloaded k3d, kubectl, helm binaries |
| `k8s/` | K8s manifests for the in-cluster worker pod (ServiceAccount, ClusterRoleBinding, Deployment) and GPU device plugin DaemonSets |
| `scripts/` | Setup, cluster lifecycle (`ensure-cluster.sh`, `alive.sh`, `cleanup-all.sh`), GPU setup, E2E monitor |

## Backend service layer

All services live in `apps/backend/src/services/`, most extend `BaseService`. Constructed and wired together in `bootstrap()` (`apps/backend/src/index.ts`):

- `InfrastructureService` — kubectl/helm/k3d/docker subprocess execution
- `ClusterService` — cluster CRUD, mock-cloud detection, kubeconfig resolution
- `AppService` — app deployment CRUD, depends on `ClusterService` + `BuilderService`
- `BuilderService` — image build orchestration
- `RegistryService` — container registry operations
- `GitModuleService` — Odoo module git integration
- `AppExposureService` — Localtunnel/Nginx public exposure of deployed apps, emits socket.io events
- `ClusterProxyService` — proxies requests into cluster-internal dashboards (Traefik/Grafana/Prometheus)
- `AuthService` — user auth (JWT sessions, 2FA, GitHub/Google OAuth)
- `CredentialService` — per-user cloud provider credentials, AES-256-GCM encrypted at rest, live validation against provider APIs
- `TemporalBridge` — bridges Express routes ↔ Temporal workflow execution; mutating routes go through this, reads hit the DB directly
- `WorkerService` — manages the in-cluster worker pod lifecycle

## Auth

All `/api/*` routes require a session (JWT in a `session` cookie) via `requireAuth` middleware in `index.ts`, except `/auth/login`, `/auth/register`, `/auth/2fa/verify`, and the GitHub/Google OAuth routes. When `IS_E2E=true`, `requireAuth` short-circuits to a mock user so Playwright doesn't need to log in. GitHub/Google OAuth fall back to a zero-setup local mock flow when their client env vars are blank; 2FA SMS falls back to a logged warning when Twilio env vars are blank.

## Cloud credentials

Per-user credentials for aws/gcp/azure/do/huggingface/github are stored via `CredentialService`, encrypted at rest, and resolved through `credential-resolver.ts`'s chain: user-stored → `process.env` → mock mode. If a provider has no credentials anywhere, that provider runs in **mock cloud mode** using local k3d containers instead of a real cloud API — this is the zero-setup dev path referenced throughout `.env.example`-style comments in `apps/backend/.env`.

## Worker architecture

Two Temporal task queues partition operations:
- `host-ops-queue` → **host worker** (`worker-host.ts`, `npm run dev:worker`). Has Docker/k3d/kubectl/CDKTF access on the host. Handles `ProvisionClusterActivity`, `DestroyClusterActivity`.
- `cluster-ops-queue` → **in-cluster worker** (`worker-cluster.ts`, runs as a pod in the k3d management cluster, or locally via `npm run dev:worker:cluster`). Has the Docker socket mounted, and K8s service-account (in-cluster) or kubeconfig (on host) auth. Handles `DeployAppActivity`, `DestroyAppActivity`, `ResizeDiskActivity`.

In-cluster worker lifecycle: `ensure-cluster.sh` creates the k3d management cluster (`provisioning-lunorica`) → `Dockerfile.worker` builds an image with backend code + CDKTF infra + kubectl/helm → `kubectl apply -f k8s/` creates ServiceAccount/ClusterRoleBinding/Deployment → the pod reads its service account and sets `K8S_HOST`/`K8S_TOKEN`/`K8S_CA_CERT` for CDKTF → mounts `/var/run/docker.sock` for docker-exec-based kubectl/helm into k3d server containers.

`AppStack.fromEnv()` (CDKTF) reads `KUBECONFIG` or `K8S_HOST`/`K8S_TOKEN`/`K8S_CA_CERT` for cluster auth.

## Temporal sync architecture

MongoDB stays in sync with Temporal via two mechanisms:
1. **`trackWorkflow()` polling** — every 5s per workflow; retries transient Temporal errors up to 12 times before giving up (avoids clusters getting stuck "provisioning" during brief Temporal outages).
2. **Background reconciliation loop** — every 30s, scans clusters in intermediate states (`provisioning`, `destroying`), checks Temporal directly, and updates MongoDB if the workflow finished but the DB missed it. Also parses log files to update `ClusterMetadata.progress` (e.g. `creating-cluster`, `patching-storage`, `deploying-cdktf`, `installing-traefik`).

Temporal itself is optional — the backend starts and falls back to plain DB polling if it's unreachable. Start it with `docker compose -f docker-compose.temporal.yml up`.

## GPU / vLLM support

Deploying a vLLM app triggers: host GPU-toolkit check → auto-install the matching device plugin DaemonSet (NVIDIA or AMD, `k8s/gpu-device-plugin/`) into the cluster → wait up to 60s for it to be ready → CDKTF applies the vLLM stack (`packages/cdktf-infra/constructs/vllm.ts`), exposing `nvidia.com/gpu` / `amd.com/gpu` to the K8s scheduler. Host-side driver/toolkit setup is `scripts/setup-gpu.sh` (auto-detects distro, idempotent).

**GPU passthrough only works on the always-on system cluster** (native k3s on Linux). k3d's nested
containerd cannot do real device passthrough at all, so user-created k3d clusters are never
GPU-enabled — `ProvisionClusterActivity` and `TemporalBridge` both rely on this.

## TypeScript quirks

- `verbatimModuleSyntax: true` → all relative imports need a `.js` extension, even in `.ts` files
- `exactOptionalPropertyTypes: true` → auto-generated `.gen/` CDKTF files have pre-existing type errors; skip them
- `noUncheckedIndexedAccess: true` → array/tuple access returns `T | undefined`

## Testing escalation path

1. **Alive** (`npm run test:alive`, `scripts/alive.sh`) — Docker, k3d management cluster, K8s API, Temporal, in-cluster worker pod. Fails fast with specific fix instructions. Runs automatically before E2E.
2. **Unit** (`npm run test:unit`) — Vitest, frontend + backend, <5s.
3. **Worker isolation** (`npm run test:worker`, `tests/worker-isolated.ts` via `npx tsx`) — runs real Temporal workflows (`ClusterProvisionWorkflow`, `AppDeployWorkflow`, etc.) end-to-end (k3d, CDKTF, Helm, kubectl) without a browser or webserver.
4. **Full E2E** (`npm run test:e2e`) — Playwright driving the React UI; starts host and cluster workers on the host network to support all deployment types.
5. **Remote-host integration** (`npm run test:remote-integration`, `tests/remote-host-integration.ts`) — boots a real disposable QEMU/KVM VM (`tests/lib/disposable-vm.ts`) and drives the actual `POST /api/clusters` (`provider: 'remote'`) → Temporal → SSH-bootstrap-k3s path against it, the same way a user adding their own GPU workstation or a Phase-3 VPS would. Slow (~10-15 min, includes a one-time ~600MB cloud image download cached in `tests/.vm-cache/`) — not in the default `npm test` chain, only `npm run test:all`.

## Playwright / k3d gotchas

- **`workers: 1` only** — E2E tests provision/deprovision real k3d clusters bound to host network ports; parallel workers collide on ports.
- **Worker restarts on failure**: a failed test restarts the Playwright worker process, which reloads the spec file and generates a *new* random `CLUSTER_NAME` (e.g. `e2e-fleet-XXX`) — but already-passed tests aren't rerun. A cascade of timeouts after one failure almost always means the *first* failure is the real bug; look there, not at the timeouts.
- **Stale k3d containers**: leftover containers from a previous run (e.g. `k3d-isolated-fleet-XXX-server-0`) can make `k3d cluster create/delete` fail. `npm run clean-dev` removes leftover k3d containers/volumes.

## Data

Default persistence is MongoDB (`apps/backend/src/lib/mongo-db.ts`), managed via `docker-compose.mongo.yml` / `scripts/ensure-mongo.sh`. Unit tests use `MemoryDB` (`NODE_ENV=test` without `IS_E2E`) — see `createDatabase()` in `db-interface.ts`.

`apps/backend/data/` still holds `logs/` (per-resource provisioning/deployment logs, tailed over
socket.io — see `InfrastructureService`'s `LOG_DIR`) and `nginx/` (proxy config). The `*.json` files
in there are unused leftovers, **not** the source of truth.

## Prerequisites

- Docker, k3d, kubectl, helm (or use pre-downloaded binaries in `bin/`)
- Node.js 20+
- Temporal workflows need the Docker container on port 7233 (`docker-compose.temporal.yml`)
- GPU workloads (vLLM) need the NVIDIA/AMD driver and container toolkit on the host — see `scripts/setup-gpu.sh`
