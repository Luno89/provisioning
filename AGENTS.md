# provisioning

Multi-cloud provisioning platform (k3d, k8s, CDKTF). Express backend + React 19 frontend.

## Repo structure

npm workspaces: `apps/*`, `packages/*`

| Path | What |
|---|---|
| `apps/backend/src/index.ts` | Express server entry — `bootstrap()` inits DB, all services, JWT auth middleware, socket.io, ~30 inline routes (no Router) |
| `apps/backend/src/lib/db-interface.ts` | `Database` interface + `createDatabase()` factory — MongoDB unless `NODE_ENV=test` and not E2E, in which case `MemoryDB` |
| `apps/backend/src/lib/mongo-db.ts` | MongoDB native driver implementation (`mongodb@^6.10.0`) |
| `apps/backend/src/lib/memory-db.ts` | In-memory mock for unit tests |
| `apps/backend/src/lib/auth.ts`, `crypto.ts` | JWT sign/verify, password hashing; AES-256-GCM encrypt/decrypt/mask for stored secrets |
| `apps/backend/src/lib/credential-resolver.ts` | Cloud credential resolution chain: user-stored → `process.env` → mock mode |
| `apps/backend/src/services/` | Service layer — see [Backend service layer](#backend-service-layer) below |
| `apps/backend/src/workflows/` + `activities/` | Temporal.io workflow/activity definitions |
| `apps/backend/src/worker-host.ts` | Host-side Temporal worker — registers cluster provisioning activities (ProvisionClusterActivity, DestroyClusterActivity) |
| `apps/backend/src/worker-cluster.ts` | In-cluster Temporal worker — registers app deployment activities (DeployAppActivity, DestroyAppActivity, ResizeDiskActivity). Reads K8s service account for in-cluster auth. |
| `apps/frontend/src/main.tsx` | React entry |
| `apps/frontend/src/App.tsx` | ~1800-line monolith — most of the UI in one component |
| `apps/frontend/src/components/` | Extracted pieces: `Login`, `CloudAccounts`, `AnsiText` (ANSI log rendering) |
| `packages/cdktf-infra/main.ts` | CDKTF entry — two stack types via `STACK_TYPE=cluster\|app` env var |
| `packages/cdktf-infra/constructs/` | Per-app CDKTF constructs, each with a Helm variant and a `-native` (raw K8s manifest) variant |
| `bin/` | Pre-downloaded k3d, kubectl, helm binaries |
| `k8s/` | K8s manifests: ServiceAccount, ClusterRoleBinding, Deployment for in-cluster worker pod; `k8s/gpu-device-plugin/` for NVIDIA/AMD device plugin DaemonSets |

## Backend service layer

All services live in `apps/backend/src/services/`, most extend `BaseService`, constructed and wired together in `bootstrap()` (`apps/backend/src/index.ts`):

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

## Worker architecture

Two separate task queues partition the operations:
- `host-ops-queue` routes cluster provisioning and destruction workflows/activities to the host worker.
- `cluster-ops-queue` routes application deployment, deletion, and volume resizing workflows/activities to the cluster worker.

- **Host worker** (`worker-host.ts`, runs via `npm run dev:worker`): Listens to `host-ops-queue`. Has Docker, k3d, kubectl, CDKTF access on the host. Handles `ProvisionClusterActivity`, `DestroyClusterActivity`.
- **In-cluster worker** (`worker-cluster.ts`, runs as a pod in the k3d management cluster or locally via `npm run dev:worker:cluster`): Listens to `cluster-ops-queue`. Has Docker socket mounted, K8s service account (when in cluster) or kubeconfig (when on host) for API access. Handles `DeployAppActivity`, `DestroyAppActivity`, `ResizeDiskActivity`.

## Commands

```
npm run setup        # bootstrap dependencies, install packages, and download pre-bundled binaries
npm run dev          # ensure k3d+temporal+mongo → concurrently start backend+frontend+host-worker+cluster-worker
npm run clean-dev    # kill all dev processes, delete k3d clusters, clean DBs (scripts/cleanup-all.sh)
npm run test         # test:unit → test:e2e:sync (alive check → unit → tests/e2e.spec.ts via Playwright)
npm run test:all     # test → test:infra:integration → test:unit:vpn
npm run test:unit    # backend + frontend unit tests (Vitest, both under 5s)
npm run test:e2e     # test:alive → Playwright against the e2e/ directory (skips unit preflight)
npm run test:infra:integration   # full cluster provision → verify → destroy (takes ~5 min)
```

Note: there are two separate Playwright suites — `tests/e2e.spec.ts` (run by `npm test` via `test:e2e:sync`) and the `e2e/` directory (run by `npm run test:e2e`). Check which one a change needs before assuming coverage.

Single workspace:
```
npm run test -w apps/backend    # backend unit tests
npm run test -w apps/frontend   # frontend unit tests
```

Backend dev: `npm run dev -w apps/backend` (uses `tsx watch --exclude data`)
Frontend dev: `npm run dev -w apps/frontend` (Vite)
Host worker: `npm run dev:worker -w apps/backend` (runs `worker-host.ts`)
In-cluster worker (manual): `npm run dev:worker:cluster -w apps/backend`

## E2E Monitor

Interactive dashboard for debugging E2E tests in real-time:

```bash
npm run dev &                    # start dev stack first
npx tsx scripts/e2e-monitor.ts   # launch monitor
```

Dashboard shows (refreshes every 2s):
- MongoDB clusters with status and progress step
- Live log tail from the active provisioning cluster
- K8s pod status for the active cluster
- Temporal workflow status
- k3d cluster list
- Worker health (host + cluster)

Menu (last line):
- `0-9, a` — run specific Playwright test
- `r` — run all non-skipped tests sequentially
- `t` — terminate running Temporal workflows
- `c` — cleanup MongoDB test collections
- `d` — full teardown
- `l` — show last log lines
- `q` — quit

## Temporal Sync Architecture

MongoDB stays in sync with Temporal via two mechanisms:

1. **`trackWorkflow()` polling** — polls every 5s per workflow. On transient Temporal errors, retries up to 12 times before giving up (prevents clusters getting stuck in "provisioning" when Temporal is briefly unhealthy).

2. **Background reconciliation loop** — runs every 30s. Scans all clusters in intermediate states (`provisioning`, `destroying`), checks Temporal workflow status directly, and updates MongoDB if the workflow has completed but the DB wasn't updated. Also parses log files to update the `progress` field on clusters.

The `progress` field on `ClusterMetadata` tracks the current provisioning step (e.g., `creating-cluster`, `patching-storage`, `deploying-cdktf`, `installing-traefik`) by parsing the log file.

## In-cluster worker lifecycle

1. `ensure-cluster.sh` creates the k3d management cluster (`provisioning-lunorica`)
2. `Dockerfile.worker` builds an image containing backend code, CDKTF infra, kubectl/helm binaries
3. `kubectl apply -f k8s/` creates ServiceAccount + ClusterRoleBinding + Deployment
4. Worker pod starts, reads K8s service account → sets `K8S_HOST`/`K8S_TOKEN`/`K8S_CA_CERT` for CDKTF
5. Pod mounts `/var/run/docker.sock` for docker-based kubectl/helm (docker exec into k3d server containers)

## TypeScript quirks

- `verbatimModuleSyntax: true` → all relative imports need `.js` extension
- `exactOptionalPropertyTypes: true` → auto-generated `.gen/` CDKTF files have pre-existing errors; skip them
- `noUncheckedIndexedAccess: true` → array/tuple access returns `T | undefined`

## Architecture notes

- **No Express Router** — all ~30 routes defined inline in `bootstrap()` (apps/backend/src/index.ts)
- **JWT auth on all `/api/*` routes** via `requireAuth` middleware, except `/auth/login`, `/auth/register`, `/auth/2fa/verify`, and the GitHub/Google OAuth routes. Session token lives in a `session` cookie. When `IS_E2E=true`, `requireAuth` short-circuits to a mock user so Playwright doesn't need to log in.
- **MongoDB is the default DB**, managed via `docker-compose.mongo.yml` / `scripts/ensure-mongo.sh`. Unit tests use `MemoryDB` instead (`NODE_ENV=test` without `IS_E2E`) — see `createDatabase()` in `db-interface.ts`.
- **Cloud credentials**: per-user creds for aws/gcp/azure/do/huggingface/github go through `CredentialService` (encrypted at rest) and `credential-resolver.ts`'s chain: user-stored → `process.env` → mock mode. A provider with no credentials anywhere runs in **mock cloud mode** using local k3d containers — the zero-setup dev path.
- **GPU / vLLM**: deploying vLLM triggers a host GPU-toolkit check → auto-installs the matching device plugin DaemonSet (`k8s/gpu-device-plugin/`) → waits up to 60s for it to be ready → CDKTF applies the vLLM stack (`packages/cdktf-infra/constructs/vllm.ts`). Host-side driver/toolkit setup is `scripts/setup-gpu.sh`.
- **Temporal.io is optional** — backend starts without it, falls back gracefully. Start via `docker compose -f docker-compose.temporal.yml up`
- **CDKTF stack selection** — env var `STACK_TYPE=cluster` for infra, `STACK_TYPE=app` for apps
- **k3d for local dev** — cluster named `provisioning-lunorica` managed by `scripts/ensure-cluster.sh`
- **App auth in-cluster**: `AppStack.fromEnv()` reads `KUBECONFIG`, `K8S_HOST`, `K8S_TOKEN`, `K8S_CA_CERT`. The in-cluster worker sets `K8S_HOST`/`K8S_TOKEN`/`K8S_CA_CERT` from the service account at startup.

## Data

Persistent state (clusters, deployments, users) lives in MongoDB — see `createDatabase()` above. `apps/backend/data/` still holds `logs/` (per-resource provisioning/deployment log files, tailed over socket.io — see `InfrastructureService`'s `LOG_DIR`) and `nginx/` (proxy config); the `*.json` files there are unused leftovers, not the source of truth.

## Prerequisites

- Docker, k3d, kubectl, helm (or use `bin/` pre-downloaded binaries)
- Node.js 20+
- For Temporal workflows: Docker container on port 7233

## Testing Escalation Path

The test suite uses a layered approach to verify correct operation and speed up local development debugging:

1. **Level 1: Alive/Infrastructure checks (`npm run test:alive`)**
   - Verified via `scripts/alive.sh`.
   - Quickly validates that Docker, K3d (management cluster), Kubernetes API readiness, Temporal.io health, and the in-cluster worker pod are running.
   - If any foundational component is missing or unhealthy, it fails fast with specific instructions on how to start or fix it.
   - Runs automatically at the start of E2E runs.

2. **Level 2: Unit tests (`npm run test:unit`)**
   - Verified via Vitest for frontend components and backend services. Runs in under 5 seconds.

3. **Level 3: Worker Isolation Tests (`npm run test:worker`)**
   - Verified via `tests/worker-isolated.ts` using `npx tsx`.
   - Runs the backend services and initiates Temporal workflows (`ClusterProvisionWorkflow`, `AppDeployWorkflow`, etc.) in isolation to verify the full backend-to-worker loop (K3d, CDKTF, Helm, and Kubectl) without browser wrappers or WebServers.

4. **Level 4: Full E2E Tests (`npm run test:e2e`)**
   - Verified via Playwright browser tests driving the React UI.
   - Starts both host-side and cluster workers on the host network to support all deployment types.

## Playwright E2E & K3d Execution Gotchas

To avoid unexpected failures during Playwright E2E test runs, keep the following in mind:

1. **Sequential Execution Only (`workers: 1`)**:
   - Because E2E tests provision/deprovision physical k3d clusters binding to host network ports, the E2E test suite MUST run sequentially. Parallel workers will cause port collisions.

2. **Playwright Worker Restart on Failure**:
   - When a test fails, Playwright restarts the worker process to avoid state leakage.
   - The cluster name (`CLUSTER_NAME`) is generated randomly at the file-level (`e2e-fleet-XXX`). 
   - A worker restart causes the file to reload, generating a *new* `CLUSTER_NAME`. However, already-executed tests (like `should provision the cluster`) are *not* re-run.
   - Consequently, all subsequent tests will time out looking for a cluster that was never created. If you see a cascade of timeouts following a single failure, inspect the *first* failed test to find the actual bug.

3. **Stale K3d Containers**:
    - If a container from a previous run (e.g., `k3d-isolated-fleet-XXX-server-0`) is not fully deleted, `k3d cluster create` and `k3d cluster delete` may fail.
    - Run `npm run clean-dev` to thoroughly remove any leftover k3d Docker containers and volumes.
