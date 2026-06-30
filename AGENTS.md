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

Two Temporal workers share the same task queue (`provisioning-ops-queue`). Activities route to whichever worker registered them:

- **Host worker** (`worker-host.ts`, runs via `npm run dev:worker`): Has Docker, k3d, kubectl, CDKTF access on the host. Handles `ProvisionClusterActivity`, `DestroyClusterActivity`.
- **In-cluster worker** (`worker-cluster.ts`, runs as a pod in the k3d management cluster): Has Docker socket mounted, K8s service account for in-cluster API access. Handles `DeployAppActivity`, `DestroyAppActivity`, `ResizeDiskActivity`.

## Commands

```
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

Backend dev: `npm run dev -w apps/backend` (uses `tsx watch`)
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
- **Temporal.io is optional** — backend starts without it, falls back gracefully. Start via `docker-compose -f docker-compose.temporal.yml up`
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
