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
npm run test:unit    # typecheck + test:unit:frontend + test:unit:backend (Vitest, ~80s total)
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

### The workers do NOT hot-reload

The backend runs under `tsx watch`, but both workers run plain `tsx` — so **any change to an
activity, workflow, or anything else they import requires restarting `npm run dev`.** Nothing warns
you; the worker just keeps executing the code it started with.

This is easy to misdiagnose because it is asymmetric. CDKTF constructs *do* pick up edits without a
restart — `cdktf` is a subprocess that reads files fresh — so a change touching both a construct and
an activity appears to half-work: the Kubernetes resources reflect your edit while the activity's
own logic (image imports, post-apply Secret creation, `displayUrl`) silently doesn't.

Confirmed live: a Palworld deploy produced a correct pod, PVC and Service from an edited construct
while the same commit's `DeployAppActivity` changes never ran, because the worker had been started
28 minutes earlier.

Note `npm run dev` uses `concurrently --kill-others`, so restarting one worker restarts the
whole stack.

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
| `apps/backend/src/index.ts` | Express server entry — `bootstrap()` inits DB, all services, JWT auth middleware, socket.io. **5,900 lines and 150 inline routes**; being extracted into `src/routes/` one domain at a time (see Structure rules) |
| `apps/backend/src/lib/db-interface.ts` | `Database` interface + `createDatabase()` — MongoDB unless `NODE_ENV=test` and not E2E, in which case `MemoryDB` |
| `apps/backend/src/lib/mongo-db.ts` / `memory-db.ts` | MongoDB native driver impl / in-memory mock for unit tests |
| `apps/backend/src/lib/auth.ts`, `crypto.ts` | JWT sign/verify, password hashing; AES-256-GCM encrypt/decrypt/mask for stored secrets |
| `apps/backend/src/lib/credential-resolver.ts` | Resolution chain for cloud creds: user-stored → `process.env` → mock mode |
| `apps/backend/src/services/` | Service layer (see below) |
| `apps/backend/src/workflows/` + `activities/` | Temporal.io workflow/activity definitions |
| `apps/backend/src/worker-host.ts` | Host-side Temporal worker — cluster provisioning/destruction activities |
| `apps/backend/src/worker-cluster.ts` | In-cluster Temporal worker — app deploy/destroy/resize activities; reads K8s service account when in-cluster |
| `apps/frontend/src/main.tsx` / `App.tsx` | React entry / **2,858-line monolith**; ~1,530 lines of it is four inline modals, being extracted slice by slice. Target: a router and shell under ~800 lines |
| `apps/frontend/src/api/` | The one axios client (`client.ts`) and one module per domain. **No component contains a URL.** |
| `apps/frontend/src/components/` | Screens and widgets. A feature with more than ~4 files gets its own folder plus a `shared.ts` — see `components/Lab/` |
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

## Root node (hosted deployment)

`scripts/root-node/bootstrap.sh` stands up a fresh VPS; `scripts/root-node/update.sh` deploys a new
version onto it. Both are idempotent and both refuse loudly rather than half-succeeding.

Updates build and typecheck **before** restarting, so a broken commit never interrupts the running
version, and roll back to the previous commit automatically if the health check fails. The restart
goes through the systemd unit so the **workers restart too** — they run plain `tsx` and do not
hot-reload, so bouncing only the backend would leave them on the old release silently.

A restart mid-provision is safe (Temporal holds the workflow state, so activities resume) but costs
one retry attempt, so the script refuses while work is in flight unless given `--force`.

**Snapshots are not rollback.** `update.sh` takes a Hetzner snapshot when a token is available, but
restoring one rolls the whole disk back — including Mongo, Temporal and Headscale, so every cluster
a tenant created since would vanish. It is disaster recovery for a broken machine, never "undo that
deploy". Rollback is git-based for exactly this reason.

## Headscale mesh

Self-managed clusters (`hetzner`, `remote`) are meant to be reached over a WireGuard mesh, not the
public internet — `constructs/hetzner-vm.ts` deliberately opens **no inbound rule for 6443**. A
tenant's own machine sits behind their NAT, so it must dial out and join; nothing can SSH inward.

**Mesh join is opt-in via `MESH_LOGIN_SERVER`** (the public Headscale URL, e.g.
`https://mesh.example.com`). Unset, provisioning keeps the old public-IP behaviour — which is what
a local dev box needs, and what every test to date exercises. Set, `TemporalBridge.provision()`
mints a pre-auth key under the owner's Headscale user and `JoinMeshActivity` enrols the VM over
SSH before k3s is installed, so the kubeconfig is written with the mesh address.

The key is passed over **SSH, never cloud-init** — `user_data` would persist a live credential
into Terraform state and the provider console.

`headscale/config/acl.hujson` is required: with no policy Headscale defaults to allow-all, so every
tenant node could reach every other. Validate changes with
`docker exec provisioning-headscale headscale policy check -f /etc/headscale/acl.hujson` — a
too-permissive policy still parses cleanly and fails open.

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

Don't infer the runtime from the kubeconfig context: the management cluster's context is named
`k3d-provisioning-lunorica` for legacy reasons **even when it is native k3s**, and
`systemctl is-active k3s` reports `inactive` because the unit is `k3s-<cluster-name>.service`.
Check `ps aux | grep '[k]3s server'` or the node's `containerRuntimeVersion` instead. The
distinction also decides whether a `hostPort` (game servers) is reachable from the host: on native
k3s it binds the host's network stack directly; on k3d it is not published without an explicit
`-p` mapping at cluster-create time.

## Structure rules

These are enforced, not aspirational: `npm run lint` is green and fails on a new violation, the
frontend is `strict`, and CI (`.github/workflows/ci.yml`) runs typecheck + lint + both unit suites
on every push. Each rule below is here because something in this repo broke without it.

### Frontend

- **PascalCase = exports a component; kebab-case = exports none.** `components/leaf-types.ts` and
  `home-summary.ts` already follow this; `react-refresh/only-export-components` is its linter.
- **Nothing at `src/` root** except `App.tsx`, `main.tsx`, `index.css`.
- **A feature with more than ~4 files gets a folder and a `shared.ts`.** `components/Lab/` is the
  model: 19 files, every panel imports `./shared` and nothing else laterally.
- **If it came from HTTP it belongs to react-query.** No hand-rolled loading/error state.
  `CloudAccounts.tsx` (21 `useState`, 9 raw `fetch`) is the counter-example.
- **UI state lives in the component that renders it**, and **never pass a raw `setState` down** —
  pass a named intent. `ClustersView` receiving `setExpandedCluster` from a 2,858-line parent that
  never reads it is the anti-pattern.
- **Client state that crosses components lives in a zustand slice** under `src/stores/`, one per
  domain — `shell.ts` (view, user, notifications), `socket.ts`. Never one store for everything: that
  is structurally what App.tsx already was. Subscribe with a selector per value
  (`useShellStore((s) => s.view)`), so an unrelated change does not re-render you.
- **Server state is react-query's, never a store.** Putting fetched records in zustand means
  hand-writing caching, dedup, invalidate-after-mutate and refetch.
- **Context is for what a store cannot do** — a value scoped to a subtree rather than the app.
  There is exactly one (`EditorSlot` in `Lab/shared.ts`) and it earns it.
- **No component contains a URL.** Components import hooks; hooks call `api/<domain>.ts`; only those
  modules import `api/client.ts`.
- **`props: any` is banned.** Let the compiler enumerate the interface — `NginxView.tsx`'s docblock
  describes the method.
- **Domain shapes are declared once**, in `src/types/` or from `@koala/harness-types`. Deliberate
  duplication across the wire carries a `── DUPLICATED, KNOWINGLY ──` block naming the backend file
  that wins; see `Lab/shared.ts`'s `isBroken`.
- **Two copies of a `useEffect` means extract a hook.** Logic that needs no React goes to `lib/` as
  pure functions with unit tests — `home-summary.ts` (29 tests) is the strongest pattern here.
- **Tests are colocated** (`Foo.tsx` → `Foo.test.tsx`) and test the extracted unit, not `App`.

### Backend

- **One-way arrow: `index.ts → routes/ → services/ → lib/`**, with `middleware/` feeding routes.
  `lib/` is pure and imports nothing above it. `lib/leaves.ts` (38 pure functions, no I/O) is the
  target shape; `lib/activity-timeouts.ts` documents why the direction matters.
- **A route handler does four things**: read the request, authorize, call one service method, shape
  the response. A loop, a prompt or arithmetic belongs in a service or `lib/`.
- **No `db.*` in a route.**
- **Something becomes a service** when it holds state beyond a request, owns a resource, or is the
  only writer of a collection. Otherwise it is a `lib/` function. `VpsCatalogService` over
  `lib/vps-catalog/` is the model.
- **One router per URL prefix in `src/routes/<domain>.ts`, exported as a factory** taking its deps,
  so `src/routes/test-harness.ts` can mount it without booting the app.
- **A test may not re-declare the logic it tests.** Two security tests did, and could not fail —
  see `lib/ownership.ts` and `lib/oauth-gate.ts`.
- **Route order in `bootstrap()` is load-bearing**: the Gitea webhook must stay before
  `express.json()` (it verifies an HMAC over the raw body), `app.use('/api', requireAuth)` before
  every `/api` router, and the SPA catch-all last.

### Two halves, two import conventions

Backend has `verbatimModuleSyntax`, so **relative imports need the `.js` extension** even in `.ts`.
Frontend uses `moduleResolution: bundler` and is **extensionless**. An editor's auto-import will
get this wrong across the boundary, and the backend form fails at runtime while sometimes
typechecking.

### One-time setup

```bash
git config core.hooksPath .githooks   # pre-push typecheck
```

## TypeScript quirks

- `verbatimModuleSyntax: true` → all relative imports need a `.js` extension, even in `.ts` files
- `exactOptionalPropertyTypes: true` → auto-generated `.gen/` CDKTF files have pre-existing type errors; skip them
- `noUncheckedIndexedAccess: true` → array/tuple access returns `T | undefined`

## Testing escalation path

1. **Alive** (`npm run test:alive`, `scripts/alive.sh`) — Docker, management cluster, K8s API, Temporal, workers. Fails fast with specific fix instructions. Runs automatically before E2E.
   - Cluster existence is decided by whether the K8s API answers on context `k3d-<name>`, **not**
     by `k3d cluster list` — that returns nothing on a native-k3s host and used to report a
     healthy machine as broken, which then suppressed every later check.
   - Also flags **stale workers**: any `apps/backend/src` file (excluding `index.ts` and tests)
     modified after the worker process started. Workers don't hot-reload, so this is otherwise
     silent — it has caused two multi-hour misdiagnoses.
2. **Unit** (`npm run test:unit`) — typecheck + Vitest, frontend + backend. ~80s (20s typecheck, 29s frontend, 29s backend). The `<5s` this used to claim has not been true for a long time.
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
