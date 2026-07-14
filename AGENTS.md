# provisioning

Multi-cloud provisioning platform (k3d, k8s, CDKTF). Express backend + React 19 frontend.

## Repo structure

npm workspaces: `apps/*`, `packages/*`

| Path | What |
|---|---|
| `apps/backend/src/index.ts` | Express server entry — `bootstrap()` inits DB, services, socket.io, all routes |
| `apps/backend/src/lib/db.ts` | `LocalDB` — JSON file persistence at `apps/backend/data/{clusters,deployments}.json` |
| `apps/backend/src/services/` | Service layer: `InfrastructureService` (kubectl/helm/k3d/docker), `ClusterService`, `AppService`, `TemporalBridge` |
| `apps/backend/src/workflows/` + `activities/` | Temporal.io workflow/activity definitions |
| `apps/backend/src/worker-host.ts` | Host-side Temporal worker — registers cluster provisioning activities (ProvisionClusterActivity, DestroyClusterActivity) |
| `apps/backend/src/worker-cluster.ts` | In-cluster Temporal worker — registers app deployment activities (DeployAppActivity, DestroyAppActivity, ResizeDiskActivity). Reads K8s service account for in-cluster auth. |
| `apps/frontend/src/main.tsx` | React entry |
| `apps/frontend/src/App.tsx` | ~1365-line monolith — all UI in one component |
| `packages/cdktf-infra/main.ts` | CDKTF entry — two stack types via `STACK_TYPE=cluster\|app` env var |
| `bin/` | Pre-downloaded k3d, kubectl, helm binaries |
| `k8s/` | K8s manifests: ServiceAccount, ClusterRoleBinding, Deployment for in-cluster worker pod |

## Worker architecture

Two separate task queues partition the operations:
- `host-ops-queue` routes cluster provisioning and destruction workflows/activities to the host worker.
- `cluster-ops-queue` routes application deployment, deletion, and volume resizing workflows/activities to the cluster worker.

- **Host worker** (`worker-host.ts`, runs via `npm run dev:worker`): Listens to `host-ops-queue`. Has Docker, k3d, kubectl, CDKTF access on the host. Handles `ProvisionClusterActivity`, `DestroyClusterActivity`.
- **In-cluster worker** (`worker-cluster.ts`, runs as a pod in the k3d management cluster or locally via `npm run dev:worker:cluster`): Listens to `cluster-ops-queue`. Has Docker socket mounted, K8s service account (when in cluster) or kubeconfig (when on host) for API access. Handles `DeployAppActivity`, `DestroyAppActivity`, `ResizeDiskActivity`.

## Commands

```
npm run setup        # bootstrap dependencies, install packages, and download pre-bundled binaries
npm run dev          # ensure k3d cluster → build+deploy worker pod → concurrently start backend+frontend+host-worker
npm run clean-dev    # kill all dev processes
npm run test         # unit (frontend + backend) → e2e (Playwright)
npm run test:unit    # backend + frontend unit tests (Vitest)
npm run test:e2e     # Playwright e2e (skips unit preflight)
npm run test:infra:integration   # full cluster provision → verify → destroy (takes ~5 min)
```

Single workspace:
```
npm run test -w apps/backend    # backend unit tests
npm run test -w apps/frontend   # frontend unit tests
```

Backend dev: `npm run dev -w apps/backend` (uses `tsx watch --exclude data`)
Frontend dev: `npm run dev -w apps/frontend` (Vite)
Host worker: `npm run dev:worker -w apps/backend` (runs `worker-host.ts`)
In-cluster worker (manual): `npm run dev:worker:cluster -w apps/backend`

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
- **No auth** on any route
- **JSON file DB** — read-modify-write pattern, prone to race conditions under concurrency
- **Temporal.io is optional** — backend starts without it, falls back gracefully. Start via `docker compose -f docker-compose.temporal.yml up`
- **CDKTF stack selection** — env var `STACK_TYPE=cluster` for infra, `STACK_TYPE=app` for apps
- **k3d for local dev** — cluster named `provisioning-lunorica` managed by `scripts/ensure-cluster.sh`
- **App auth in-cluster**: `AppStack.fromEnv()` reads `KUBECONFIG`, `K8S_HOST`, `K8S_TOKEN`, `K8S_CA_CERT`. The in-cluster worker sets `K8S_HOST`/`K8S_TOKEN`/`K8S_CA_CERT` from the service account at startup.

## Known bugs / design debt

- `TemporalBridge.updateUserStatus()` was wiping `kubeconfigPath` on workflow completion, causing kubectl to run on the host with stale kubeconfig → `0.0.0.0:6443 connection refused`
- `apps/backend/src/lib/executor.ts` duplicates `InfrastructureService.ts` with hardcoded paths — dead code
- Hardcoded secrets in `packages/cdktf-infra/constructs/odoo-native.ts` (and similar constructs)
- Frontend app defaults (image repos, tags) are hardcoded in `App.tsx` instead of server-driven
- Shell scripts under `apps/run-container/` are mostly echo messages / dead code (the in-cluster worker is now deployed via `k8s/` manifests)

## Data

All persistent state is JSON files under `apps/backend/data/`. In test/E2E mode, `clusters-test.json` and `deployments-test.json` are used instead.

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

3. **Stale Host-Network Containers crash K3d**:
   - K3d has a known bug when using `--network host`. If a container from a previous run (e.g., `k3d-isolated-fleet-XXX-server-0`) is not fully deleted and remains on the `host` network, `k3d cluster create` and `k3d cluster delete` will fail to parse the IP prefix of the network and crash with:
     `failed to parse IP Prefix of network "host"'s member...: ParseAddr(""): unable to parse IP`.
   - Run `npm run clean-dev` to thoroughly remove any leftover k3d Docker containers and volumes.
