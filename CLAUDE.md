# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Multi-cloud provisioning platform (local-first): spin up Kubernetes clusters (k3d locally, or AWS/GCP/Azure/DO) and deploy apps (Odoo, WordPress, Nextcloud, Audiobookshelf, vLLM, Open WebUI) with public internet access via Nginx + Localtunnel — no port forwarding needed.

```
React UI (Vite :5173) → Express API (:3001) → Temporal.io (workflows) → CDKTF (Terraform) → k3d / AWS / GCP / DO
```

npm workspaces: `apps/*`, `packages/*`.

## Agent Rules & Standards

1. **Zero Half-Implementations**: NEVER half-implement any feature, view, route, or subsystem. Every feature must be 100% implemented end-to-end across the entire stack — backend services, persistence, API contracts, frontend UI, real-time events, and operational tests. Never leave half-wired buttons, superficial veneers, stubbed callbacks, or partial capabilities.

   Every one of these shipped in this repo and passed its tests:
   - **A control the server never reads.** Level 2's "sandbox" toggle was sent and stored, but nothing branched on it.
   - **A fake that passes by construction.** A mock model that calls exactly the tools the case expects, scored by checking those same tools, cannot fail.
   - **Canned tool handlers standing in for real ones.** `run_command` "succeeded" unless the command contained the word `fail`.
   - **An invented placeholder shown as real.** The studio displayed a made-up three-node graph for any case naming a built-in procedure, then ran it.
   - **Data kept only in memory** when the feature is a list of history the user comes back to.
   - **A field sent in a shape its consumer silently ignores.** `{ temperature }` where the model call reads `{ toolTurn, conversation }`.

   Product-level mock modes this file documents (mock cloud mode, the OAuth and Twilio fallbacks) are features, not stubs. Test doubles belong in tests.
2. **Proactive Questioning & Architectural Alignment**: If you are not 100% confident about requirements, terminology, design trade-offs, or system boundaries, STOP and ask the user directly before proceeding. Never guess or assume intent. Check existing plan documents (`~/.claude/plans/`, `CLAUDE.md`) and project history first so questions are informed and focused on unsettled decisions. Any architectural decision, abstraction boundary, or UX paradigm shift MUST be surfaced to the user for explicit review and sign-off.
3. **Mandatory Live Operational E2E Verification**: Never declare any feature or capability "done" based solely on unit tests or typechecks. You MUST perform a live, end-to-end operational verification against the running application (e.g. authenticating, exercising actual HTTP/WebSocket routes, validating client payload contracts, verifying state mutations) proving the exact user flow succeeds end-to-end before concluding.

   A live check must go through the real path. A run in a mock mode proves the mock. When reporting, name what was exercised live and what was not.

## Commands

```bash
npm run setup        # bootstrap: deps, CDKTF bindings, pre-bundled binaries, k3d cluster, worker pod, env
npm run dev          # ensure k3d+temporal+mongo → concurrently: backend, frontend, host-worker, cluster-worker
npm run dev:split    # the same stack as root and your instance: root at http://koala.localhost:5175 (sign in there), your instance at http://dev.localhost:5173
npm run clean-dev    # kill all dev processes, delete k3d clusters, clean DBs (scripts/cleanup-all.sh)

npm run test         # test:unit → test:e2e:sync (alive check → unit → tests/e2e.spec.ts via Playwright)
npm run test:all     # test → test:infra:integration → test:remote-integration → test:unit:vpn
npm run test:unit    # typecheck + test:unit:frontend + test:unit:backend (Vitest, ~80s total)
npm run test:alive   # scripts/alive.sh — Docker/k3d/K8s API/Temporal/worker pod health, fails fast with fix hints
npm run test:worker  # tsx tests/worker-isolated.ts — runs real Temporal workflows without browser/webserver
npm run test:e2e     # test:alive → Playwright (skips the unit preflight `npm test` does)
npm run test:infra:integration    # full cluster provision → verify → destroy, ~5 min (tests/infra-integration.ts)
npm run test:routing-live         # root's Caddy on the mesh (local CA, koala.localhost) → a named instance installs on a VM → <name>.<domain> answers through Caddy and sign-in lands there → an app on the instance at <app>-<name>.<domain> → a group the instance claims is routed by root to its edge (the edge's 404 names the instance in X-Koala-Edge) and freed again → nested addresses issued and shown, the flat ones still answering, ~30 min, cleans up
npm run test:mail-live            # the send-only mail server is built and run beside a test mailbox → the backend's mailer sends an alert through it → it arrives DKIM-signed and the signature verifies against the key the DNS script publishes → a host it does not trust is refused, ~2 min
npm run test:monitoring-live      # a throwaway app on the system cluster → Monitoring calls it healthy → Koala, on your model, proposes an alert for when it stops answering → the card sets it → the app is stopped until the alert fires and the conversation hears it, started until it resolves → the alert is removed and the app destroyed, ~10 min
npm run test:telemetry-live       # against the running dev stack: the collector and Tempo are on the system cluster (the cluster worker applied them if they were missing) → a throwaway account signs up with an admin's invite → one scripted turn through the check runner → one trace in Tempo, found by the id the request answered with, spans the request, the check workflow's start, the engine run's request, its workflow start and the model call, with nothing said in it → koala_up, the request, workflow, activity and model-call metrics are in Prometheus by name, labelled with the process → the Koala section on GET /api/infrastructure carries them → the stack stays; removes the scenario and the account, ~3 min
npm run test:infrastructure-live   # Infrastructure reads the system cluster → a workload that cannot pull its image, put there by hand, shows in Needs attention and on the cluster page as not deployed through Koala, then leaves once removed → a Koala chat turn on a model that does not exist shows as failed work, opens its chat and clears → whatever the memory keeper keeps from the run and the quiet conversation is retired, ~15 min
npm run test:dev-split-live        # against a running `npm run dev:split`: the instance sends a signed-out person to root → root's Google sign-in (the dev mock) → root knows the instance and serves none of its routes → its one-time token signs you into the instance, and not twice → your work is there and the instance makes no accounts → the instance's credential is taken by root and a wrong one refused, ~10 s
npm run test:hub-live              # against the running dev stack (combined): an admin's invite signs up an owner, who makes two shared projects and invites a collaborator and a client to one and someone else to the other → root shows each invite signed out and signs up only the address invited → the outsider reaches nothing of the first project by id, guess or another's invite → each role can do only what it may → roles change, an invite is taken back, people are removed and leave, the last owner cannot → the owner's removal refused while they alone own a project someone else is on, the outsider's removal taking them off it → one project deleted by name and the owner's removal deleting the other, their databases gone, ~1 min
npm run test:project-sharing-live  # against the running dev stack (combined): a throwaway project with a repository and a channel someone talked in → the group check refuses a dashed and a reserved name and suggests one from the project's name, sharing without a group is refused → the preview says what goes and stays, nothing is on the hub → shared under its group, which the preview and the hub's project carry, and a second project is refused that group → the channel arrives with its history and a new message follows → a commit on the owner's main reaches the hub's and one pushed to the hub's reaches the owner's → taken back by its name: the hub's database and repository are gone, everything stays on the instance → the group is free again and the second project is shared under it and taken back; the account removes itself, ~30 s
npm run test:routes-live           # against the running dev stack: signed out, the guard answers before any router, the webhook and /ingress/verify before the guard and /api/metrics wants its token → a throwaway account signs up with an admin's invite → one request to each of the 58 mounted routers answers with the router's own response, never Express's "Cannot GET"; the account removes itself, ~5 s
npm run test:app-names-live        # against the running dev stack: two owners each deploy an app called shop on the system cluster → both run, each in a namespace of its own (`<name>-<six of its id>`), each owner sees only theirs → a redeploy by the same owner goes to the same app, not a second one; destroys both and removes the second account, ~5 min
npm run test:openrouter-connect-live # against a running `npm run dev:split`: signed in through root, Connect OpenRouter sends you to OpenRouter's sign-in with a PKCE challenge and a state → a state Koala did not make is refused before OpenRouter is asked → OpenRouter's refusal of a made-up code is told in plain words → nothing changed; approving on OpenRouter is yours, ~5 s
npm run test:machine-story-live    # against the running dev stack and this computer's machine agent: a scripted ACP agent is added to your machine by hand → the planner, on it, proposes a one-story tree through propose_plan → approved, the first run stopped → every agent in the tree's work put on the machine → the story is worked in a checkout on the machine, checked with run_in_workspace and its task check in the tree's workspace, judged and settled by the scripted judges → it succeeds, label.txt is on main and no machine branch is left; removes the tree, the conversation and the agent, retires what the memory keeper kept, ~30 min (most of it the keeper)
npm run test:machine-odoo-live     # against the running dev stack and this computer's machine agent: a scripted ACP agent is added to your machine and every agent of an Odoo 20 tree is put on it → the module is written without its test, odoo-check runs as the task check, the judge on the machine says not met, the story fails and the planner, in its checkout on the machine, reads leaves/<story>.failed.md and proposes a replan → approved, the test is met and the browser task's judge ends without a verdict, so that task fails and is never taken as met → replanned again, the browser task is met, the leaf judge verifies, it lands on main with no machine branch left, the starter is live in slot a and the landed build previews in slot b with the module installed; removes the project, the conversation and the agent, ~30 min
npm run test:machine-chat-live     # against the running dev stack and this computer's machine agent: a scripted ACP agent is added to your machine → a chat in auto mode on it hands work to research, which works a checkout of the chat's documents on the machine, runs run_in_workspace, writes label.md and outlives the cut-off where a served call becomes a job the agent follows with wait_for; nothing asks, label.md is in the chat's workspace, the saved reply keeps research's steps and no machine branch is left → a chat not in auto mode asks before research runs something, naming the machine, and the test declines it → research with no conversation works in its own folder, search_web running for it, no run_in_workspace → two research hand-offs at once write the same file, and the one whose work comes back second is told the conflict in its session and keeps both; removes the chats and the agent, ~6 min
npm run test:machine-default-live  # against the running dev stack and this computer's machine agent: a scripted ACP agent is added to your machine and made your account default (another machine is refused) → a chat turn with no model picked runs on it and answers from it → a run that cannot be handed to a machine fails saying to add a model; your previous default, the agent and the chat are put back or removed however it ends, ~1 min
npm run test:files-live            # code dropped on a throwaway project's repository is committed whole (binary bytes included) → the project keeps its other files on your MinIO: a PDF and a JSON file come back byte for byte, a folder moves, a file goes, an empty folder is made, a search finds a file two folders down → a share link opens with no session and stops once revoked → a file attached in the project's chat is stored there and Koala, on FILES_LIVE_MODEL (else your default), reads it with read_stored_file → deleting the project empties its folder, ~5 min
npm run test:pool-live            # a VM becomes a pool node through scripts/root-node/pool-node.sh (k3s, the mesh as tag:pool, gVisor) → root and its host worker as containers offer a trial → the person starts one: a vcluster under gVisor, its ports on the node, Koala installed in it → every pod on gVisor, a pod without it refused, no node port → <name>.koala.localhost through root's Caddy over the mesh, sign-in lands there, a sandboxed run inside it, ~40 min, cleans up
npm run test:byo-live             # disposable QEMU VM runs the real `curl …/install.sh | sudo sh` from a root container → instance on the VM → sign in → sandboxed run → self-upgrade check-in, ~15 min, cleans up
npm run test:machine-live        # a fresh Ubuntu VM runs the command from My Machines → the agent runs as a user service and finds an ACP agent and two CLIs missing their adapters (`--adapters none`) → after a reboot with nobody logged in it connects again → Install adapter makes Claude Code ready → the command run again with `--yes` installs Codex's adapter; removes the machine, its project and the VM, ~10 min
npm run test:mesh-live           # the image is built; root starts; the owner's instance installs in a VM and joins the mesh, its Temporal answering only on its mesh address → a second VM runs the command from the instance's My Machines, joins the mesh with a key root mints for the instance, and its worker polls the instance's Temporal over the mesh → a third VM, another person's, reaches neither and neither reaches it; ~30 min, removes everything
npm run test:big-run-live         # real research run on your model, continuing as new each step; asserts every history event < 512 KB and that big payloads went to Mongo
npm run test:memory-live          # Koala chat → a second message resets the countdown → keeper runs after the quiet time → a new chat recalls it, ~25 min
npm run test:bench-live           # throwaway agent passes on an idle-started bench run, is broken, and the next idle bench names the regression, ~10 min
npm run test:proposals-live       # Koala corrected in chat → the memory keeper proposes a test → accepted and run, ~25 min
npm run test:practices-live       # a correction → a practice on trial → the bench tries it → live or held → recalled, ~45 min
npm run test:changes-live         # a prompt change compared on the bench and accepted; a procedure request handed to the agent builder, ~30 min
npm run test:account-removal-live # a fresh account with a project, its repository and a conversation removes itself through DELETE /api/account → its session and sign-in are refused at once → an admin sees it go → nothing of it is left in any collection, Gitea or Kubernetes, ~1 min
npm run test:odoo-release-live     # a throwaway project on the system cluster: its push builds and releases into slot a, a new module is prepared in slot b and previewed, cut over and rolled back, then deleting the project takes the live app, its namespace and its release workflow with it, ~5 min
npm run test:tree-to-release-live  # new trees made through the API: an Odoo tree gets its own project and its starter goes live in slot a, an API tree gets one and is built and deployed, a paper tree gets none; ~10 min, removes everything
npm run test:checks-live          # a Level 2 run on the check runner (CHECKS_LIVE_SCENARIOS picks which; default seven model scenarios on your model): each in a fresh hidden space, driven through the API → every run opens for you afterwards → no space is left behind
npm run test:instance-live        # k3d cluster + root container + charts/instance → sign in through root → sandboxed run → the instance removes no account and points at root, where a throwaway account removes itself and its instance is let go of, ~10 min, cleans up
npm run test:remote-integration   # boots a disposable QEMU VM, provisions it as a provider:'remote' cluster over
                                   # real SSH, verifies kubectl + deploys a real app, tears down VM+cluster — proves
                                   # the distributed-systems plan's Phase 2 (SSH k3s bootstrap) end-to-end, ~10-15 min.
                                   # Needs qemu-kvm/cloud-utils/genisoimage + /dev/kvm (tests/remote-host-integration.ts)
```

Every `test:*-live` script runs through `tests/lib/run-live.ts`, which records when it last passed and last failed in
`tests/last-passed.json` and the table `tests/LAST-PASSED.md`; a script nobody has run for weeks shows there.

Note: there is ONE Playwright suite, `tests/e2e.spec.ts` (11 tests, `testDir: './tests'`).
`npm test` reaches it via `test:e2e:sync` (unit preflight first), `npm run test:e2e` runs it
directly. The `e2e/` directory this used to describe was deleted — it sat outside `testDir`
and never ran.

Per-workspace scripts (`test`, `lint`, `dev`, `dev:worker`, `dev:worker:cluster`) run the standard
way: `npm run <script> -w apps/backend`. See each workspace's `package.json` for what they invoke.

Run a single test file: `npx vitest run <path>` from the relevant workspace dir, or `npx playwright test <file>` from repo root.

### In dev, everything hot-reloads — and a reload kills what is running

`npm run dev` runs the backend and all three workers (host, cluster, engine) under `tsx watch`, so
an edit to anything they import restarts them within a few seconds. You no longer restart by hand.

Workflow files are not imported: Temporal bundles them from `workflowsPath`. The workers' dev scripts watch them
with `--include 'src/workflows/**'`; without that, a change to a workflow does nothing until the worker restarts
for another reason — a fix can look applied and not be.

The cost is that **a restart kills every activity that worker is running.** Temporal retries an
idempotent node on the new worker once its heartbeat lapses, so a model turn or a sandbox
provision just resumes. A node that is *not* idempotent — Code, Start Leaf, File Claim, anything
whose definition says `idempotent: false` — gets exactly one attempt (`engineNodesOnce` in
`AgentRunWorkflow.ts`), so the run fails at that node. **Saving a file during a live grove or
agent run can fail the run.** Wait for it to finish, or expect to start it again.

Production does not watch: `npm run start` (what the root node's systemd unit runs) uses plain
`tsx`, which is why `update.sh` restarts through the unit. `npm run dev:steady` is the dev stack with the three
workers on plain `tsx` too (the backend still reloads), for a long live run that a save must not kill.

Note `npm run dev` uses `concurrently --kill-others`, so a worker that crashes rather than reloads
takes the whole stack down with it.

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
| `apps/backend/src/index.ts` | Express server entry — `bootstrap()` inits the DB, keys, role and the platform services, then calls each area's `wire*` (`src/<area>/wiring/`), which constructs that area's services and mounts its routers. 437 lines. Three routes are inline and each has a reason: the Gitea webhook (must precede `express.json()` — it verifies an HMAC over the raw body), `/ingress/verify` (unauthenticated by design) and `/api/metrics` (its own token). `index.test.ts` guards the route order; `npm run test:routes-live` proves every router is mounted |
| `apps/backend/src/<area>/` | **The backend is laid out by area, each with `lib/` (pure rules), `services/`, `routes/` (one router per URL prefix, a factory taking its deps) `wiring/` (what constructs the area from the platform deps and mounts it), `store.ts` (its records) and `index.ts` (all another area may import).** The areas: `platform` (database, keys, crypto, the Temporal client and payload storage, auth middleware, mail, notices, metrics, migrations, the shared record types), `accounts` (sign-in, invites, admin, account removal), `instances` (root, instance, addresses, the pool, moves), `hub` (shared projects), `projects` (projects, repositories, channels, item chats, trees, branches, leaves, plans, secrets, tree types), `releases` (A/B releases, customizations, client imports, what is live), `files` (MinIO files, drops, artifacts, share links), `machines` (a person's machines, their agents, the sockets), `monitoring` (health, alerts, notifications), `models` (providers, the default model, OpenRouter), `memory` (the keeper, recall, practices), `checks` (Level 2, the bench, scripted models), `infrastructure` (clusters, apps, deploys, exposure, egress, credentials, backups, running work, the Temporal bridge), `engine` (runs, conversations, agents, procedures, tools, MCP, workspaces, auto mode). `engine-host/`, `extensions/`, `activities/`, `workflows/` and `eval/` stay where they were. Find a file by area first: `git ls-files apps/backend/src/hub` is the hub |
| `apps/backend/src/platform/lib/db-interface.ts` | `Database` is `init`, `close` and one store per area (`db.projects`, `db.engine`, …); `createDatabase()` is always MongoDB |
| `apps/backend/src/<area>/store.ts` | **The area's records**: `interface <Area>Store` and `Mongo<Area>Store`, its collections, indexes (`ensureIndexes`) and every read and write of them. A service reads another area's records through `db.<area>` or a `Pick` of that store, never through the driver. `MongoDB` composes the fourteen stores and wraps the projects and engine stores in the hub-write marker |
| `apps/backend/src/platform/lib/mongo-db.ts` | The MongoDB implementation, the only one. Unit tests get a real Mongo from `platform/lib/test-database.ts`: `testDatabase()` opens a fresh database on the `mongodb-memory-server` that `vitest.global-setup.ts` starts once per run, and `vitest.setup.ts` drops every database a file opened when it ends |
| `apps/backend/src/platform/lib/auth.ts`, `crypto.ts` | JWT sign/verify, password hashing; AES-256-GCM encrypt/decrypt/mask for stored secrets |
| `apps/backend/src/infrastructure/lib/credential-resolver.ts` | Resolution chain for cloud creds: user-stored → `process.env` → mock mode |
| `apps/backend/src/platform/middleware/` | `asyncRoute` + the error responder, and `auth.ts`'s `createAuth()` — `requireAuth`, `requireAdmin`, the session cookie and the invite gate. Express 4 does not await handlers — an unwrapped async handler that rejects sends NO response and the request hangs |
| `apps/backend/src/workflows/` + `activities/` | Temporal.io workflow/activity definitions |
| `apps/backend/src/worker-host.ts` | Host-side Temporal worker — cluster provisioning/destruction activities |
| `apps/backend/src/worker-cluster.ts` | In-cluster Temporal worker — app deploy/destroy/resize activities; reads K8s service account when in-cluster |
| `apps/frontend/src/main.tsx` / `App.tsx` | React entry / the router provider. Nothing else sits at `src/` root but `index.css` |
| `apps/frontend/src/shell/` | The shell: the router (`router.tsx`), `RootLayout.tsx` (sign-in, the socket wiring, the modals), the sidebar, the shell routes and Settings, which composes several areas' sections. The only code that may import every feature; nothing imports it but `App.tsx` |
| `apps/frontend/src/features/<area>/` | **The frontend is laid out by area, named as the backend's**: `platform` (the session API, the route and toast helpers, the `shell` and `socket` stores), `accounts`, `instances`, `hub`, `projects`, `releases`, `files`, `machines`, `monitoring`, `models`, `memory`, `checks`, `infrastructure` and `engine` (chat, the Studio, runs). Each has `api.ts` (or `api/<domain>.ts` when it has several), `types.ts` (or `types/`), `components/`, `hooks/`, `lib/` (pure, tested), `stores/` where it keeps client state, `shared.ts`, and `index.ts`, **the only thing another area imports**. Find a screen by area first: `ls src/features/hub` is the hub |
| `apps/frontend/src/shared/` | UI that belongs to no area: Koala, `KoalaLoading`, `Markdown` and its chat parser, `AnsiText`, `ConfirmDelete`, the debounce hook, Monaco's setup. Imports no feature |
| `apps/frontend/src/api/client.ts` | The one axios client. Only a feature's `api` modules call it. **No component contains a URL.** |
| `packages/cdktf-infra/main.ts` | CDKTF entry — stack type selected via `STACK_TYPE=cluster\|app` env var |
| `packages/cdktf-infra/constructs/` | Per-app CDKTF constructs, each with a Helm variant and a `-native` (raw K8s manifest) variant |
| `bin/` | Pre-downloaded k3d, kubectl, helm binaries |
| `k8s/` | K8s manifests for the in-cluster worker pod (ServiceAccount, ClusterRoleBinding, Deployment) and GPU device plugin DaemonSets |
| `scripts/` | Setup, cluster lifecycle (`ensure-cluster.sh`, `alive.sh`, `cleanup-all.sh`), GPU setup, E2E monitor |

## Backend service layer

Services live in their area's `services/` folder (`apps/backend/src/<area>/services/`), most extend `BaseService` (`platform/services/`). Each area's `wiring/` constructs them, called from `bootstrap()` (`apps/backend/src/index.ts`):

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

All `/api/*` routes require a session (JWT in a `session` cookie) via `requireAuth` from `platform/middleware/auth.ts`'s `createAuth()`, mounted in `bootstrap()`, except `/auth/login`, `/auth/register`, `/auth/2fa/verify`, and the GitHub/Google OAuth routes. When `IS_E2E=true`, `requireAuth` short-circuits to a mock user so Playwright doesn't need to log in. GitHub/Google OAuth fall back to a zero-setup local mock flow when their client env vars are blank; 2FA SMS falls back to a logged warning when Twilio env vars are blank.

**Limits and headers.** Sign-in, sign-up, 2FA, handoffs, invites, joins and share links are rate limited per address
(`platform/lib/http-limits.ts`, mounted on `/api` before the guard), an account is locked for fifteen minutes after ten wrong
passwords (`lockedUntil`), every response carries `helmet`'s headers, and the proxy is trusted in production. **The SPA's
content security policy** (`platform/lib/csp.ts`: same-origin scripts, sockets and frames, inline styles allowed, blob workers and
media, nothing framed from elsewhere) is sent as `Content-Security-Policy-Report-Only` in production until `CSP=enforce`
(`CSP=off|report|enforce` sets it anywhere); the browser's reports land on `POST /csp-report` and are logged as one line
each, so a week of a quiet log on the host is what says to enforce it. **Koala reports on itself** at `GET /api/metrics` (`MetricsService`, prom-client: process metrics, request
times by route and status, failed work by kind), read with `Authorization: Bearer <METRICS_TOKEN>`; unset, nothing is
served. The same request times and failures, and everything else Koala measures, also leave every process as
OpenTelemetry to the collector on the system cluster (**Koala's own telemetry**, below), and each response carries its
trace id in `x-trace-id`. **Startup migrations run once**: `scripts/seed-all.ts` runs each by name through `platform/lib/migrations.ts` and records
it in `migrations`; the shipped seeds (tree types, tools, providers) still upsert on every boot.

The public-path allow-list lives in `platform/middleware/auth.ts`, **not** in `accounts/routes/auth.ts` — a router
that could exempt itself is a router that can quietly stop being protected, so adding a route that
must work signed-out means editing the guard too. `requireAuth` and the Socket.IO handshake share
`userFromSessionCookie` for the same reason: a socket must never be able to resolve a user the HTTP
API would reject.

## Account removal

`RemoveAccountWorkflow` (engine worker) removes an account and everything it owns: it stops the account's
workflows (its projects' release workflows and running builds too), destroys its apps on their clusters, deletes its workspace namespaces (by the `koala.dev/owner` label, which release namespaces carry too), project secrets, mesh machines,
Gitea user and repositories, then every record, the account last. A person removes their own account from
Settings (typing their email), an admin removes anyone's from Settings → People. It is refused while the account
still has clusters or deployed apps, and for the only admin. The moment it starts, the account's sessions and
sign-in are refused (`userFromSessionCookie`), and no run can start for it (`closing` in the run starter).

**On root and an instance, an account is root's.** An instance removes no account (it mounts no `/api/account`): its
Settings → Delete account links to root's `/#/remove-account` (`GET /api/auth/account-removal`, `IdentityService.removalUrl`).
That page (`accounts/components/RemoveAccountPage.tsx`, also linked from the no-instance page) shows what goes, their instance
included (`preview`'s `instance`: a pool one deleted with everything in it, one on their own machine let go of while it
keeps running there), takes the typed email, and starts `RootAccountRemovalWorkflow` through root's own `DELETE /api/account`,
the same removal an admin's is.

Removal, project deletion and tree deletion stop workflows by **cancelling** them (`platform/lib/stop-workflow.ts`), never by
terminating: a cancelled agent run still runs its own ending — it ends `interrupted` and hands its claimed tasks
back. Only one that has not closed within `STOP_WAIT_MS` of being cancelled is terminated. Terminating skips all of
that, so a task the run was working on would stay `running` forever.

A closed workflow does not stop an activity already in flight (engine activities are abandoned on cancel), so when
removal stopped anything it waits
`ACTIVITY_STOP_GRACE_MS` (a few node heartbeats — an activity hears it was stopped on its next one) before it hands
runs over (`keepRunsFor`, what the check runner uses) and deletes records. It finds runs through the turn logs, and
each run's memory keeper by name (`memoryRunId`); the memory keeper never runs for a check's space.

**Project deletion** (`RemoveProjectWorkflow`, the "Delete project" popup on a project's page, which lists what
goes before anything does) deletes the trees whose home is the project, with their leaves, conversations, workspaces
and repos; the project's repo (and its build webhook), Infisical workspace and reader identities, builds and
records. A tree only also linked to it, and a conversation or memory that only mentions it, are kept and unlinked.
An app built from the project goes with it: once the project's workflows (its release workflow among them) are stopped, each of its deployments is destroyed on its own cluster through `executeDestroyAppWorkflow` on the cluster worker, and the popup lists the app among what goes. A project being deleted ignores pushes.

`ACCOUNT_DATA` in `accounts/lib/account-removal.ts` classifies every Mongo collection as removed by owner, by id, through
what it relates to, or shared; a test fails when a collection in any `src/*/store.ts` is missing from it, so **a new
collection has to say how it is removed**.

## A person's own machines

My Machines → Add a machine gives `curl -fsSL <koala>/machine.sh | sh -s -- <code>` (`scripts/machine/machine.sh`, served
with the backend's `PUBLIC_URL`; the code is single-use and lasts an hour, `MachineService.createJoinCode`). Run as the
person, it needs Node 20+, asks which folder Koala may work in, trades the code at the public `POST /api/machines/join`
for the device's token and settings (kept in `~/.config/koala/machine.json`, mode 600, never printed), joins the mesh
when `MESH_LOGIN_SERVER` is set, installs the machine agent (`GET /api/machines/agent.tgz`: `apps/local-agent` bundled by
`scripts/bundle-machine.mjs`, with its runtime packages installed by npm on the machine, protobufjs 8 among them so Temporal's packages share one copy
and an offloaded payload can be read) and starts it as a user
service (systemd `--user`, launchd). The device worker reaches Temporal at `MACHINE_TEMPORAL_ADDRESS` (default the
backend's own). Each time it connects the agent looks for coding agents (`agent-discovery.ts`: Gemini CLI, Antigravity,
Claude Code and Codex through their ACP adapters, Goose, and any the person added by hand on My Machines), confirms each
by an ACP `initialize`, and reports them (`agents:found`); only confirmed ones run. A CLI whose adapter is missing shows
with Install adapter, which asks the machine to install it (`agent-install.ts`) as the ACP registry lists it now
(`claude-acp`, `codex-acp`, `antigravity-acp`; the adapters moved from `@zed-industries` to `@agentclientprotocol`, and
an adapter under its old name is still found): its build for this machine when it has one, otherwise its npm package with
`npm install --global --engine-strict` (the current Claude and Codex adapters need Node 22, and a refusal says so). For
Antigravity (found by its sign-in in `~/.gemini/antigravity-acp` or the IDE), that is Google's ACP server, downloaded from the
ACP registry's listing into `~/.local/share/koala/agents/antigravity-acp`. The script offers the same before it starts
the service (`agent.mjs agents`, `agent-setup.ts`): it lists what it found and asks, on the terminal, whether to install
each missing adapter; `--adapters all|none` answers for every one (`--yes` means all), and with no terminal it installs
nothing. Running the command again on a machine already
added replaces that machine (the script sends the old token from `machine.json`, on stdin) instead of adding a second.

**A machine's worker reads its instance's payloads like any other worker.** The machine is inside its owner's instance,
so on every connect the agent asks for the payload keyring over its socket (`machine:payloads`, only where tenants are
served; `machines/lib/machine-payloads.ts`), holds it in memory only, and starts its device worker with the same converter as
every platform worker (`buildDataConverter` in `@koala/engine-core/payloads`, one codec shared by the backend and the
machine). Payloads over 128 KB go through the backend over that socket (`payloads:put`/`payloads:get`, `remote-blobs.ts`),
since a machine never reaches Mongo. A new keyring restarts the worker (`DeviceWorkerHost`). Without this nothing sent to
`device-<id>` could be read; `machine-live` and `mesh-live` now run a two-turn chat on the machine to prove it.

**Picking an agent on a machine.** Every model picker except Checks has a "My machines" section:
one row per ready agent per machine, `machine:<deviceId>:<agent>` (`machine-choice.ts`). A run picked that way runs the
`external-agent-chat` procedure (chat) or `external-agent-task`, on that machine (`machineRunFor`, refused with
`MACHINE_UNAVAILABLE` when the machine is gone, offline or its agent is not ready). An agent whose "Runs on" (Studio) is a
machine always runs there. A chat's own model reaches as far as the person says in the model drawer (`modelReach` on
the conversation, sent with each run, carried on the ticket): **this chat and the agents it hands work to** (the default)
hands it down the runs it starts, a machine only to an agent whose procedure branches at Where It Runs (`handedDown` in
`EngineResolveAgentActivity`; any other keeps its own model); **this chat only** leaves them on their own; following the
account default reaches nothing. **The account default can be an agent on a machine** (Studio → Models, or the first-model dialog; `PUT /api/models/default`
checks the machine is the person's and its agent ready): a run that names no model and whose agent has none of its own (or the default overrides it)
goes there when it is a chat or its procedure branches at Where It Runs (`accountMachineFor` in `machines/lib/machine-runs.ts`, read by the registry's `runnable`
through `accountDefault`); anything else that would need a model fails with `MACHINE_DEFAULT_NEEDS_MODEL` from `ModelService.route`. A check's space
never takes it. **The first-model dialog** (`models/components/FirstModel.tsx`, shown to anyone without a default) offers Connect OpenRouter, a model on their own machine
(Infrastructure → Your own hardware, then TabbyAPI or vLLM) and a subscription agent through My Machines, and lists ready machine agents to pick.
`npm run test:machine-default-live` proves it. A conversation keeps one
session per machine, agent and model (`machineSessions`), so the next turn resumes it; a failed turn is saved with its reason.

**An agent on a machine does a tree's work** (external-cli-agents step 4). A procedure branches at **Where It Runs**
(`where-it-runs`: machine when the run's model or the agent's "Runs on" is a machine, else model): `agentLoop` (tool-rounds,
planning, research) and `do-one-task` hand their Model Turn and Tool Loop to the **External Agent** node on the machine
branch, and `do-one-task` asks its verdict question with **Ask the Machine Agent**; every step around them (claim, check,
judge, record) is unchanged. An agent on a machine keeps its own procedure when it branches (`machineRunFor`'s `inPlace`,
carried on the ticket and the run's launch), otherwise it gets `external-agent-task` as before. **Where it works follows
from that:** a run that keeps its procedure gets the environment it would get on a model (what it was handed, else the
conversation's workspace in a chat, else its agent's own; `describe` in `environments.ts`, the provision step), and only an
`external-agent-task` or `-chat` run gets the bare machine folder, which `runChild` never hands to a child. A workspace says
what it keeps in git (`repository` on the workspace, `repositoryOf`: a tree's the project's repository, a conversation's its
documents, made in Gitea the first time work goes to a machine, `pushBranch`). Given a workspace that keeps one,
External Agent works a checkout of that folder (a story's worktree, a judge's checkout, the repo root): the folder's work is
committed and sent to Gitea as `machine/<device>/<run step>` (`EngineMachineSendActivity`, `sendBranch` in
`workspace-documents.ts`), the machine fetches it into its own folder for that step, `<root>/koala-trees/<workspace>/<folder>@<run step>` (`MachineGitActivity`,
`apps/local-agent/src/machine-git.ts`), so agents working the same folder at once never share a checkout, and the session works
there; `run_in_workspace` brings its work in and runs a command in the workspace; when the turn ends the machine commits and
pushes, and the work is laid over the folder (fast-forward, anything uncommitted in the way set aside in a stash), merged in when
the folder moved on (another agent's work landed first), and **never refused**: when it conflicts, the workspace as it is now is
merged into the agent's checkout on the machine and the agent, still in its session, is told which files conflict and resolves
them (`mergeIn`, `toMerge`; mid-turn this is `run_in_workspace`'s answer, at the end a follow-up `prompt`), repeating while it
makes progress. A push is refused while conflict markers remain. When the agent will not or cannot resolve them, its work is
pushed as it is and kept as the branch `machine/<device>/<run step>` in the workspace, with a notice (`keepWork`,
`keepBranchScript`). Then the session closes, the branch is deleted from Gitea and the machine's folder removed. Behind the
`machine-merges` patch. In a sandbox that
keeps no repository (a run's own) the agent works in its own folder on the machine, Koala's tools it calls run in the
sandbox, and there is no `run_in_workspace`, since nothing carries its files across; it is told so (`describeOnMachine`). The machine reaches
Gitea only through the backend (`/api/machines/git/<repo>.git`, `MachineGitService`, its device token; the person's own
repositories only, pushes only to its own `machine/<device>/` branches, git never prompting). A tree's Models offer
machines for every agent whose procedure branches (`treeModelProblem`, the picker's My machines in `TreeModels`), and
`propose_tree_model` may name one. `npm run test:machine-story-live` proves it.

**An agent on a machine is told everything a model is.** The machine branch builds its context from the same steps as
Model Turn (the persona's prompt, Describe Environment, Describe Procedure, Describe Tools, Recall Memory, Describe Outputs)
and hands it over with the opening (the task and its inputs) once. Wired with Where It Runs' `machine`, Describe Environment
first says **how it works there** (`describeOnMachine` in `runtime/context.ts`): its folder is a checkout of the workspace's
folder at the same commit; the project runs in the workspace, reached with run_in_workspace; the workspace text that follows
is written for an agent inside it, so its commands are run_in_workspace's; what is in the folder goes back when the turn
ends; Koala's tools are on the MCP server `koala`. Describe Tools lists what is served (the persona's tools not bound to an
environment, and run_in_workspace) and names the environment tools it has for itself on the machine. `AgentRunWorkflow.test.ts`
("what an agent on a machine is told") checks every section and that the MCP server serves exactly the tools listed.

**Asks from an agent on a machine** are checked against the tree's workspace, so a tree on auto mode lets them through. The
approval box on a run or story also offers **Auto mode for <agent>** and, on a tree's or a story's page, **Auto mode for this tree**:
`POST /api/engine/runs/:id/approve` with `auto: 'agent' | 'tree'` switches auto mode on (the run's agent from its turn log,
`runOrigin`; its tree from the tree run's id) and allows the call.

**An agent on a machine gets its persona's tools, and runs on the model picked.** The external-agent procedures resolve the
persona's tools (Resolve Tools) and hand them to the `external-agent` step, which serves every one not bound to an
environment (the agent has its own shell and files) through the machine's local MCP server, named `koala`, and tells the
agent to call them there. A call the agent makes is held on the machine and handed back to the run (`state: 'calls'`):
`runExternal` runs it the way a model's call runs (`runOne`: the turn log, cards, hand-offs), asking the person first when
the tool is destructive, then answers the machine (`op: 'result'`); a cancelled run answers held calls as cancelled. Discovery
opens a session (no prompt) to read each agent's `model` config option (ACP `configOptions`), reported as `models` with
`agents:found`; the picker offers one row per model (`machine:<device>:<agent>:<model>`), a run sets it with
`setSessionConfigOption` before its first prompt (a model the agent no longer offers is refused), and the model it ran on
comes back on the step (`model`), in the trace summary and so on the run's rounds. Every call the agent makes at once is
handed to the run together (`state: 'calls'` carries `calls`) and run together, `run_in_workspace` ones one at a time,
each answer going back as it comes (`op: 'results'`). Some agents give up on a tool call: Antigravity's own harness cuts
every MCP call off at 3 minutes, whatever the server does (progress messages, which the machine sends on a streamed answer,
do not help, and nothing in ACP sets it). So a served call not answered within 2½ minutes answers the agent with a job id
and keeps running in the run; the machine's own `wait_for` tool waits for the job and hands over its result
(`external-agents.ts`, told to the agent in `TOOLS_LINE`).

## Roles: root, instance, combined

`ROLE` (read by `platform/lib/platform-role.ts`) decides what a backend is:
- **`combined`** (the default, and every dev box) is everything at once, as before;
- **`root`** holds accounts and the Ed25519 signing key (`ROOT_IDENTITY_KEY`), and mounts no tenant
  route — every tenant router is mounted on `tenant` in `bootstrap()`, which is the app except on root;
- **`instance`** serves one owner (`INSTANCE_ID`, `INSTANCE_OWNER_ID`, `ROOT_URL`, `ROOT_PUBLIC_KEYS`),
  has no account routes, and signs people in only through root.

**Both on one machine: `npm run dev:split`** (`scripts/dev.sh --split`, setup in `src/scripts/dev-split.ts`, rules in
`instances/lib/dev-split.ts`). Your usual stack becomes the instance: same database, Temporal, workers, port 3001, at
`http://<DEV_INSTANCE_NAME, default dev>.localhost:5173`. Root is one more backend (port 3002) with its own database
`koala_root`, holding only your account (identity fields, never your credentials or settings) and the instance's
registration with a credential, at `http://koala.localhost:5175`. Each has its own Vite forwarding `/api` and
`/socket.io` to its backend (`KOALA_BACKEND`), so each host keeps its own session cookie; port 5174 is avoided because
the app treats it as the E2E port and signs everyone in. The env each process gets is written to
`apps/backend/data/dev-split/` (gitignored); the owner is the first admin, or `DEV_INSTANCE_OWNER`.

Sign-in on an instance: the instance sends you to root's `/api/identity/go`, which issues a 60-second,
single-use token for your instance and redirects to `<instance>/#/handoff?token=…`. The instance
checks the signature, audience, expiry and owner, records the token id so it cannot be reused, and
sets its own session. Register an instance with `npm run instances -w apps/backend -- add <id> <owner> <url>`.

**Addresses (per-user instances step 6).** A person picks a name when their instance is made (`instances/lib/instance-names.ts`:
3–20 lowercase letters and digits, no dashes, some reserved; unique on root, fixed afterwards, asked on root's "Use my own
machine" with `GET /api/instances/name-check`). With `INGRESS_DOMAIN` set, root's `InstanceRoutes` writes each ready
instance's routes from its record (name, `meshIp` from the installer's reports) into `data/caddy/instances/` and
`data/caddy/instance-sites/` and reloads Caddy: `<name>.<domain>` → the instance's backend over the mesh (`:30320`), and
`<app>-<name>.<domain>` → its **edge** (`:30321`), a Caddy beside the instance's backend that serves the apps it publishes
(`AppExposureService` in edge mode writes the same per-app blocks, plain http, and reloads it through its admin API; an app on
the instance's own k3s is reached through that cluster's Traefik by service name). Root also routes `<app>-<group>.<domain>`
to the edge of the instance holding that group (`groups` on the instance record, one `@apps_<group>` matcher each in
`instanceRouteFiles`; a shared project's apps are addressed under its group, below). Root's Caddyfile holds one `*.<domain>`
site with every instance's matchers (anything else is a 404) under a wildcard certificate over Cloudflare DNS-01
(`docker/caddy`, `CLOUDFLARE_API_TOKEN` in root's compose env only), or Caddy's local authority with `ROOT_TLS=internal`.
A person can switch to nested addresses (instance Settings → Addresses, `PUT /api/instance-addresses` → root's
`PUT /api/instances/addresses`): root adds a `*.<name>.<domain>` site with its own certificate and probes it until it is
served (`issuing` → `ready`, with Caddy's reason while it is not, a rate limit included); only then does the instance show
`<app>.<name>.<domain>`, and the flat addresses keep answering. `npm run test:routing-live` proves it with a VM, root's
Caddy on the mesh as `tag:platform`, an app deployed on the instance, and the switch.

**The hub: projects shared between people** (plan `~/.claude/plans/project-hub.md`; step 1, its people, is built). A
`hub` role (`ROLE=hub`, needing `ROOT_URL`, `ROOT_PUBLIC_KEYS` and `HUB_CREDENTIAL`; part of `combined`, `servesHub`) holds
shared projects: a registry database (`HUB_DATABASE`, default `koala_hub`: `shared_projects`, `shared_memberships`,
`shared_invites` token → project, `shared_people`, `shared_handoffs`) and **one database per project** (`hub_<id>`, its
`members` and `invites`; `hub/lib/hub-store.ts`, `hub/lib/hub-mongo.ts`). `HubService` reads the person's membership from the
project's own database before anything, and answers 404 to anyone not on it. Roles (`can` in `hub/lib/hub.ts`): **owner**
(everything; several allowed, the last cannot leave or be demoted), **collaborator** (works stories, sees code, approves),
**client** (sees, pins, comments, asks Koala; no code, secrets or settings). `/api/hub/*`: projects (made from a project's
Settings → People, `origin` the project, opened again rather than made twice), invites, roles, remove/leave, delete (typing
the name drops its database), invitations. **Inviting goes through root**: the hub posts to root's `/api/hub-link/invite`
with its credential (root knows it by `HUB_URL` and `HUB_CREDENTIAL_HASH`; combined calls `ProjectInviteService` in
process), root makes an invite code bound to that email (`checkAndConsumeInvite` refuses any other address), emails
`<root>/#/join?code=…&project=<join token>` when it sends mail and otherwise hands the link back to show. Root's join page
(`hub/components/RootJoinPage.tsx`) shows the invite signed out (`/api/hub-link/invitation`), signs them up, remembers the invite
across sign-up (`hub/lib/pending-join.ts`) and sends them on: `/api/identity/go?to=hub&next=/hub/join/<token>` issues a token
with audience `hub`, and the hub takes anyone root vouches for (never an admin there), going on to `next`. The hub's own
frontend is only Shared projects (`HubShell`, `onHub` on `/api/auth/me`). An instance links to it through root
(`hub` on `/api/auth/sign-in`). `dev:split` runs the hub as a third process at `http://hub.localhost:5176` (API :3003).
**Removing an account lets the person go from the hub first** (`HubPeople`: in process when combined, otherwise root's
signed requests to the hub's `/api/hub-root/people/:id`, a token for audience `hub` and that person and step,
`issueMoveToken`). It is refused while they are the only owner of a shared project someone else is on (`leavingAll` in
`hub/lib/hub.ts`, listed among the removal's blockers); a project only they are on is deleted; from every other one they are
taken off, with the invites they sent; the hub forgets its copy of them. Not yet: the board, channel and repository on the
hub (step 2's member screens), members working stories (3), the View tab (4).

**Sharing a project (step 2).** A project stays entirely on its owner's instance until they share it from its Settings →
People, which first lists what goes (the board, the channel and story and feature chats with their history, the
repository) and what stays (other chats, secrets, builds and releases, the app; `ProjectSharingService`,
`/api/project-sharing/:id`). Sharing makes the hub's copy (`HubService.share`, only from an instance: in process when
combined, else `/api/hub-instance/*` with a token root signs for the instance and its owner, `POST /api/instances/hub-token`,
`RemoteHub`) and a repository in the project's own Gitea organisation (`shared-<id>/project`, a bot with write access whose
token only the owner's instance holds; `HubRepos`). **The sharer names a group** when sharing (one per shared project, the
instance-name rules through `nameProblem`, suggested from the project's name by `suggestedGroup`, checked as typed at
`GET /api/project-sharing/:id/group-check`), and the project's apps are addressed `<app>-<group>.<domain>` instead of under
the owner's name (`<app>-<instance name>` on an instance, `<app>-<id>` combined). The group is kept on the link (`HubLink.group`)
and the hub's project (`SharedProject.group`, shown to its members), fixed while the project is shared, and freed when it is
taken back, its apps returning to the owner's addresses. Root holds the groups for routing (`PUT`/`DELETE
/api/instances/groups`, `GET /api/instances/groups/check`, the instance's credential, `InstanceGroups`; a group is refused when
it is any instance's name or another project's group), combined checks only its own links (`localProjectGroups`). Sharing or
taking back republishes the apps (`syncExposedApps`): `AppExposureService` asks `groupOf` (the hub link of the app's
project), and `addressScope` in `instances/lib/edge-addresses.ts` decides the scope, so a stored address outside it is
recomputed. A group's addresses are flat only; nested addresses cover the owner's own name. A project shared before groups
has none and keeps the owner's addressing. **The owner's instance keeps a working copy** and the engine is
unchanged: every write to a tree, branch, leaf, task, conversation or plan proposal marks it (`markingHubWrites` wraps
`createDatabase()`, so every process does; `hubDirty`, only while anything is shared), and `HubSyncService` (every 3 s)
sends a shared project's records as field patches against what the hub last agreed (`hubSnapshots`; chat messages one by
one, `hub/lib/hub-sync.ts`), pulls what others changed (applied without marking), and syncs `main` with git (`HubRepoSync`:
fast-forward whichever is behind, merge when both moved, on a conflict neither changes, the hub's main is kept as
`hub/main-<time>` and the channel is told). The hub orders changes per project (`changes`, `board_*` in `hub_<id>`) and
takes them only from the sharer's own instance. **Taking it back** (typing its name) deletes the hub's copy and
repository; a project deleted on the hub stops being shared on its instance at its next sync, and deleting a shared
project on its instance takes it back first (the delete popup says so).

**Members work a shared project on the hub** (step 2's second half). The hub's `/shared/:id` is Board · Files · People,
the board the same screens as the instance's (`ProjectBoard` reads through a `WorkSource`, `features/projects/lib/work-source.ts`;
the hub's is `features/hub/lib/hub-work-source.ts`, polling `GET /api/hub/projects/:id/board` every 3 s). What each role
sees is cut on the hub (`recordFor`, `statusFor` in `hub/lib/hub-board.ts`): a client gets stories and tasks without claims,
runs or checks, chats without reasoning or tool calls, what is live and a waiting preview but no builds; owners and
collaborators see everything, the run feed included, relayed from the owner's instance (`HubRelay`: the instance
long-polls `GET /api/hub-instance/projects/:id/relay`, answers `POST /api/hub-instance/relay/:callId[/stream]`; a call
fails cleanly when the instance is offline). Members' writes are **requests** (`POST /api/hub/projects/:id/requests`:
approve or reject a plan, order stories or features, accept or drop a task, open a story or feature chat, ask Koala)
that `HubSyncService` on the owner's instance carries out as the owner once the messages they refer to have synced
(`HubInstanceWork`), and settles done or refused; the board shows what waits and why. Posting in a chat
(`POST .../conversations/:id/messages`) syncs down like any message, named by the member's email (`authorName` on
messages the viewer did not write, in both UIs); Koala answers owners and clients on the owner's instance (an
`ask-koala` request starting the turn), collaborators from their own instance in step 3. The owner's instance sends a
**status** (`PUT .../status`: releases, builds, tree runs) every 15 s or when the project moved. **Files**: the hub
relays the owner's MinIO (`FileScope` `{kind: 'hub'}`); an owner or collaborator marks a file or folder **Shared with
clients** (`clientFiles` on the project, `hub/lib/client-files.ts`, `PUT .../files/for-clients`, also on the instance's
Files page once shared), a client sees only those and may add files, which are then shared. The hub's repository is
read-only to owners and collaborators (`GET .../repository`, `.../repository/file`). Where root has no hub,
Share says so. `npm run test:project-sharing-live` proves it combined.

**Trial instances on Koala's servers (the pool, per-user instances step 5c; plan `~/.claude/plans/pool-instances.md`).**
Someone with no machine of their own can try Koala on a **pool node**: root's own k3s (`bootstrap.sh` sets it up) or a server of
its own (`scripts/root-node/pool-node.sh`: k3s, the mesh as `tag:pool`, root's registry, gVisor). Root offers it on the "no
instance yet" page while a slot is free (`POOL_SLOTS`, from the node's memory) and only with `POOL_ADDRESS` (the node's mesh
address), `POOL_KUBECONFIG` and `INGRESS_DOMAIN` set (`poolSettingsFrom` in `instances/lib/pool.ts`). `PoolInstanceWorkflow` (host
worker, `POOL_TASK_QUEUE`):
- readies the node: RuntimeClass `gvisor` (`scripts/root-node/gvisor.sh`, pinned gVisor), the `koala-pool-gvisor`
  ValidatingAdmissionPolicy refusing any pod in a `koala.dev/pool=true` namespace not on gVisor (proved to refuse before
  use), and `pool-proxy`, a hostNetwork Caddy in `kube-system` whose ConfigMap root writes;
- makes a namespace `pool-<name>` (PodSecurity baseline) and a vcluster in it (chart 0.37.2) whose control plane and every
  synced pod run under gVisor, with root's quota and limit range and no node ports;
- gives the instance three ports (`freePorts`): its backend and edge on the node's mesh address, its Gitea registry on the
  node's 127.0.0.1, which containerd pulls over plain HTTP with nothing configured;
- installs the instance chart in pool mode (`pool.enabled`: no Docker, cluster-only Gitea, Infisical, searxng and crawl4ai,
  each component's memory set) through a Job in the pool namespace, since root cannot reach a vcluster's API from outside
  its cluster;
- waits until the proxy reaches the backend, then marks it ready; `InstanceRoutes` sends `<name>.<domain>` to its ports.
In pool mode an instance pushes images to Gitea by its in-cluster name and gives pods the loopback name
(`instances/lib/registry-hosts.ts`, `REGISTRY_PULL_HOST`, `KOALA_REGISTRY_PUSH`). kubectl port-forward cannot reach a gVisor pod.
**Gitea answers nobody signed out** (`REQUIRE_SIGNIN_VIEW` in `scripts/ensure-gitea.sh`; a dev box that already had Gitea runs
`bash scripts/ensure-gitea.sh` once, since `npm run dev` does not) and its users are private (made so,
and every existing one patched at boot, `GiteaService.makeUsersPrivate`), so every pull of a Koala-built image needs a login:
each namespace Koala pulls one into gets the secret `koala-registry-pull` (the bot's read-only package token,
`GiteaService.registryLogin`; shapes in `instances/lib/registry-pull.ts`) and its `default` service account names it (release
namespaces through `SlotCluster`, at every release step and for every released project at boot; browser tests through
`namespacedCluster`), and a sandbox pod names it itself. A move copies a `default` service account only for its pull secrets.
**The trial** (`PoolTrialWorkflow`, rules in `instances/lib/pool-trial.ts`): emails 3 days and 1 day before the end, stops the
vcluster at the end (status `paused`, so sign-in and routes skip it), warns again 3 days before deleting it 30 days later.
While a move runs the trial holds (`PoolTrialNextActivity` answers `hold`).
**Root watches pool apps; a pool instance has no monitoring of its own** (`monitoring/lib/pool-monitoring.ts`). Its cluster gets only
the operator's CRDs and a ClusterIP Traefik (`CLUSTER_MONITORING=crds`, `INGRESS_SERVICE`; `placedOnPool`). Root's
`PoolHostActivity` installs one kube-prometheus-stack (no Grafana, `enforcedNamespaceLabel`, kube-state-metrics keeping
vcluster's `vcluster.loft.sh/namespace` label and `object-name` annotation) and a blackbox exporter that never follows a
redirect, per node; each pool namespace lets only that exporter in (`probeIngressPolicy`). The instance asks root named
questions, never PromQL (`MonitoringService`'s `pool` dep → `PoolMonitor` → root's `/api/instances/monitoring/*` with its
credential → `PoolMonitoringService`, which builds each query with `place` so it reads only `pool-<name>`, joining pods and
volumes to the namespace they came from, `monitoring/lib/monitoring-asks.ts`). Its probes (read from the Probe CRs its apps make) and
its alert rules (rebuilt by root from the six templates) are written by root into its host namespace; alerts come back with
their namespaces translated. Not on a pool place: Open in Grafana, request counts and the `errors` alert (shown as not
measured), and changing how long history is kept (`byKoala`).
**Root's admin area, `/#/admin`** (`features/instances/components/RootAdmin.tsx`; `/#/pool` opens its pool section): People (every account and
its instance, own machine or pool), Invites, and Koala's servers (places in use, the default trial length, `poolSettings`
seeded from `POOL_TRIAL_DAYS`, each person's trial end, which moving ahead warns again and starts a stopped instance, and
Delete, typing the name, `PoolRemoveWorkflow`). Removing an account on root runs `RootAccountRemovalWorkflow` (host worker):
a pool instance is deleted, its mesh user and nodes removed, its records removed; what is on a person's own machine stays
theirs. An instance mounts no `/api/admin`, and its Settings shows People and Invites only where accounts are held
(`holdsAccounts` on `/api/auth/me`).
**Moving to their own machine** (plan `~/.claude/plans/pool-instances.md`, design A). The person starts it on root's page
(also for a stopped trial, which is started again only for the move) or in the instance's Settings
(`/api/instance-trial/move` → root's `/api/instances/move/self`). Root gives the install command with a single-use move
code (`startMove`, a join token with `move`) and starts `PoolMoveWorkflow`. The machine joins as the same instance (same
name, a new credential kept as `move.credentialHash` until the switch), takes the instance's four keys
(`MOVED_KEYS`) into `<release>-keys` before Helm, and installs the chart with `move.enabled`: workers at zero, the setup
jobs `move-data` (the data folder) → `platform-services` (with the moved secrets) → `move-restore` (Mongo through
`instances/lib/mongo-move.ts`, Gitea's and Infisical's Postgres through `PG_RESTORE` into a fresh schema, Gitea's data volume
through a helper pod) → `seed`. Every part comes through root (`/api/instances/move/parts/:part`, the move credential):
root's `MoveRelay` reaches the pool instance's backend through the pool node's API server with a token it signs for that
instance and part (`issueMoveToken`), never storing anything. The pool instance (`MoveExport`, `/api/move/*`) checks the
token, refuses while work runs, and stops taking work (every other route answers 503, `.moving` in its data folder) until
root thaws it. The installer then turns `move` off and reports `ready` with `moved`; root switches the record (credential,
mesh address, no pool), removes the pool copy and frees its ports. A failure reported by the machine, or Stop the move,
thaws the pool copy and stops it again if it was stopped. `npm run test:pool-live` proves the pool, its monitoring, root's
admin removal and the move on two VMs (`POOL_LIVE_ENDING=delete` ends with an admin's Delete instead of the move).

**Every cluster that runs apps has monitoring.** Before an app is deployed, `ensureClusterMonitoring`
(`activities/cluster-monitoring.ts`, rule in `monitoring/lib/cluster-monitoring.ts`) asks the cluster whether it serves
`probes.monitoring.coreos.com` and has blackbox-exporter. It applies whatever is missing: the cluster stack (`ENV=remote`,
with `CLUSTER_INGRESS=existing` keeping an ingress the cluster already has, such as k3s's Traefik, so two never fight
over ports 80/443) and the observability stack. An instance's cluster worker does the same when it starts. A failure
fails the deploy with the reason; an app never goes on without its probe. A failed deploy keeps its record in the
listing even when its namespace was never made.

## How an agent holds a tool

An agent never lists its own tools. What it holds is its **grants** (`toolGrants`, many to many, neither the agent
nor the tool records the other): **shipped** ones, declared by each extension as `grants` (`extensions/*/personas.ts`,
the engine's own in `SEEDED_GRANTS`) and never stored; the person's own, **granted** (the Studio, an approved
proposal); and **revoked** ones, which take a shipped tool away from their agent. `toolsOf` / `withGrants` in
`agent-engine/src/agent/grants.ts` resolve them; the backend reads every agent through **`AgentDirectory`**
(`engine-host/registries/agent-directory.ts`, which also drops what a switched-off extension brings), and writes only
through its `setTools` (`grantChanges` turns the wanted list into grants and revocations). So a built-in agent stays
built in when only its tools change — the Studio says so, and saving stores grants, not a copy — and keeps getting
shipped changes. The resolved agent (`Persona`, with `tools`) is what the engine runs; what is stored is a
`PersonaRecord`, without them. A grant change starts the agent's image rebuilding and tells the bench, like an agent
save. Check spaces copy the person's grants, and a world's `agents.<slug>.tools` becomes grants there. Startup moves any
stored agent's old tool list onto grants (`engine/lib/tool-grant-migration.ts`, in `seedAll`) and drops a copy of a built-in
that differed only in its tools.

**MCP servers are a catalogue of their own** (`mcpServers`, `engine/lib/mcp-servers.ts`, Studio → Tools, under MCP servers, `/api/mcp/catalogue`).
A server runs hosted (at a URL, or one of the person's MCP deployments, recorded as they run, `from: { projectId }`) or in
the workspace (what installs it, the command that starts it, its port and path). Known ones ship as templates
(`extensions/mcp/templates.ts`: Playwright, with Chromium installed against the Playwright its package bundles). Adding
or saving one **captures** it with the `capture-mcp-server` procedure (`extensions/mcp/`, agent `mcp-capture`, no model):
a hosted one is asked over HTTP; a workspace one has its image built (`planServerImage`) and is started in the capture
run's own sandbox, which the run's cleanup step releases. `initialize` and `tools/list` are kept on the record —
instructions, tools, the fingerprint of how it ran — or why it failed; a server is offered only while its capture
matches how it runs now (`usable`). Agents **hold** servers through grants of `kind: 'server'` (stored under a key of
their own, so a server and a tool may share a name; `persona.servers` resolved like tools), renamed and dropped with the
server. A held workspace server's install joins the agent's image and the tree workspace (`heldWorkspaceServers` in the
composer, each line `server:<name>`). Runs never list a server: `ServerTools` (`engine-host/tools/server-tools.ts`)
offers each held (or chat-enabled, hosted) server's captured tools as `<server>__<tool>`, filtered by `offer`/`omit`,
each tool's effect from the server's hints or the person's `kind`, grouped in the prompt under the server with its
instructions, the person's notes and what it depends on, and each tool's note as its guidance; calls go to
`WorkspaceServers` (started in the run's pod on first use, one `curl` per request) or to the hosted address. A check's
world can carry `mcpServers` (captured before the run) and give an agent `servers`; `mechanics-workspace-server` proves
the workspace path. Startup (`migrateMcpServers` in `seedAll`) moves `persona.mcp`, tools that served, and per-tool kinds
onto the catalogue. **Koala proposes servers**: `list_mcp_servers` shows the person's servers (state, tools, who holds each) and the
known ones not added; `propose_mcp_server` (rules in `engine/lib/mcp-proposals.ts`) puts an `add_mcp_server` action card in
the chat — add a known one (with the person's notes, depends-on, offer/omit), add a new one, or give one they have to
agents. Applying it (`ActionService`) adds and captures the server, then gives it to each agent named through
`setServers`, which rebuilds a workspace server's holders' images. `mechanics-proposed-server` proves it (check stage
`applyAction`, expectation `mcpServer`).

**Tool calls run together where they can** (`run-tool-calls`, behind the `reads-together` patch): hand-offs start at
once, calls to tools whose `effect` is `read` (from the Tool Loop's `offered`) run together, and a call that changes
something waits for every call before it and runs on its own.

**When a run asks before a call** (the `approve-tool-calls` step, `ports.approve` in `AgentRunWorkflow`): on someone's
own machine every call asks; elsewhere a destructive tool asks (an MCP tool is destructive unless its server says
otherwise). A call to a tool that runs inside the run's sandbox (`binding: 'environment'` while the environment is a
sandbox) never asks, whatever it does (behind the `sandbox-calls-unasked` patch). **Auto mode** turns asking off for a
whole run: a person switches it on per agent (Studio, the agent's settings; `autoModeSettings`, so a built-in stays
built in), per tree (the tree's Settings page; `autoMode` on the tree) or per chat (**Auto mode** beside the model in the
composer, on and off at any time; `autoMode` on the conversation, `PUT /api/auto-mode/conversations/:id`, set atomically so
a turn's messages are never overwritten), and a run goes unasked when its agent is on, the tree it works on — its sandbox's
`tree-<id>` workspace or its chat's tree — is, or the chat it runs for is, which reaches every agent the chat hands work
to, since a child's ticket carries the conversation (`AutoModeService.unasked`, read at each ask through
`EngineAutoModeActivity`, behind the `auto-mode` patch). The approval box answers the call its notice names (`callId`)
and says what was decided. A chat's approval card offers Allow, Allow for this run, Allow <tool> in this chat, **Auto mode
for this chat** (switches it on and lets the call through; so does switching it on while something asks) and Deny.

## Memory

Memories are made by the `memory-keeper` agent, never by a hidden model call. It is driven by events,
not polling. `AgentRunWorkflow` reports `turn-started` and `run-ended` to the backend
(`EngineConcludeActivity`), and `MemoryKeeperService` (rules in `memory/lib/conclusions.ts`) hands the
keeper each conclusion:
- a conversation whose `ConversationConclusionWorkflow` countdown ran out — the conversation agent's
  `concludeAfterMinutes` (default 10), held while a turn runs and restarted by every new turn — or
  one where a card was accepted or a plan approved (`onSettled`);
- a leaf the leaf-judge settled;
- a run that failed, or a research run.

It searches, saves, replaces or retires with `search_memories` / `save_memory` / `forget_memory`,
and reads runs with `read_run`. It can also propose a test (`propose_scenario`), a practice for one
agent (`propose_practice`, tried on the bench before it goes live), a prompt change (compared on the
bench, always waiting for the person), or a procedure change in plain words (handed to the agent
builder). Each waits on the page of the agent it is for (Studio → Agents → Proposed changes). The live tests retire whatever their own runs leave
behind (`tests/lib/forget-test-runs.ts`), since they feed the keeper made-up situations. Watermarks in `memoryWatermarks` mean nothing is processed twice,
Koala also holds
`save_memory` for what the person states outright.

**A memory or a practice can be kept for one model** (`model` on the memory: the model's own name, as a turn's
binding has it — `provider.model`, never the endpoint). The recall step takes the turn's binding, so one is recalled
only when that model works (`selectForContext`); without a binding, none kept for a model is. The keeper sees the model
in `read_run` (from the `choose-model` trace) and names it on `save_memory` / `propose_practice`, refused unless it is
one of the person's models. The bench tries a model's practice on an endpoint serving that model, leaving it on trial
while none does; every check result records the model it ran on, and regressions and prompt-change comparisons only
compare results on the same model (`sameModel` in `checks/lib/bench.ts`). The Memories page and the agent's practices show
and filter by model; `mechanics-memory-per-model` proves recall on a script (a scripted space's model is `scripted`).

**A tool note is advice shown beside a tool** (`category: 'tool_note'`, with `tool` — a built-in's name, or a server's
tool with `server` — or `server` alone for all of a server's tools; `engine/lib/tool-notes.ts`). The keeper proposes one with
`propose_tool_note` when runs misuse a tool rather than when one agent works badly (that is a practice), naming the
tool as it is offered. It goes on trial: the bench runs the checks that use the tool (`scenarioSubjects(...).tools`,
any of the server's for a server note) with it in the space, and it goes live only if a check that failed before now
passes and nothing regressed (`trial.better`); otherwise, or when no check uses the tool, it waits for the person. Resolve Tools takes the turn's binding and puts each live note on its tool
(`learned`) or server (`servedBy.learned`), shown as "Learned from earlier runs"; one kept for a model only on that
model. Notes never reach the memory bank or the Memories page; they show on the tool's and the server's Studio pages
(Learned notes), follow a server's rename and are retired with it. `mechanics-tool-notes` proves it on a script.

## Checks

Level 2 scenarios — **checks** — run on the **check runner** (`CheckRunWorkflow`, engine worker), never in-process.
Plan: `~/.claude/plans/testing-levels.md`.

- **A fresh space per scenario**: a hidden account (`user.space`, no password, never listed among people) with the
  person's agents, procedures, tools, tree types, extension settings and live practices — not their data — plus the
  scenario's world (`tasks`, `memories`, `procedures`, `files`, `agents` settings, a `project`). It is removed with
  `RemoveAccountWorkflow` afterwards, and every check ends with "its space leaves nothing behind" — so every check
  run is also a live test of account removal.
- **Who plays the model**: the person's model (the space borrows it — `ModelService` resolves as the person), or a
  **script** (`scenario.script`, `checks/lib/check-script.ts`): rules matched on what a model sees (`offered`, `called`,
  `notCalled`, `asked`, `system`, `said`) answering with `say` and/or `call`, with lookups (`{{asked.N}}`,
  `{{said.N}}`, `{{directory}}`, `{{mentioned.task|leaf}}`, `{{result.<tool>}}`, `{{world.<path>}}`). The backend
  serves it at `/api/checks/scripted/:space/v1` (public prefix in the auth guard, checked by a per-space key) and
  records every request, so a check can assert `modelSaw`. A request no rule answers fails the run with what was asked.
- **Driven through the API, as the space** (`CHECKS_API_URL`, default the local backend), answering questions and
  approvals as they come, then reading what the run left: the turn log, `/documents`, tasks, run effort.
- **Flows**: `then` adds stages after the first run — `chat` (optionally `killAfterChars` to kill it mid-turn),
  `approvePlan`, `runTree`, `waitQuiet`, `deleteTree`, `deleteProject` — each with its own expectations, including
  plumbing ones: `modelSaw`, `compacted`, `summaryKept`, `interrupted`, `turnLog`, `leaves`, `repository`,
  `pullRequests`, `workspace`, `project`, `trees`. Check names say which stage they belong to.
- **The mechanics checks** (`eval/level2/mechanics.ts`, built in, scripted, so they run in seconds and on the bench):
  the judge's verdict, the turn log (and a run killed mid-turn), research in one shared workspace through the quiet
  time, compaction, landing, project deletion, and an Odoo module built and checked in an Odoo 20 workspace. They replaced the `*-live` scripts that tested the same plumbing.
- **Turn checks** (`turn: true`, `checks/lib/turn-check.ts`) are one model turn of an agent: its tools offered, nothing run
  (procedure `turn-check`). `chooses` names the tool it should pick (or `null` to answer without one) and checks its
  arguments, read from the model call's trace. They replaced Level 1; the built-in ones are `eval/level2/turns.ts`.
- **Any check can repeat** (`repeats`, `passAt`, `checks/lib/check-attempts.ts`): a turn check's attempts share one space, any
  other gets a fresh space per attempt; the result keeps every attempt, and a space that leaks fails the check whatever
  `passAt` allows. Coverage (`checks/lib/check-coverage.ts`) and comparing two runs (`checks/lib/check-compare.ts`) count every attempt.
- The space's runs are handed to the person before it goes, so every result still opens in the run view.
- **The Studio** (Agents, Tools, Procedures, Tree Types) is one explorer per concept (`features/engine/components/Studio/Explorer.tsx`):
  items grouped by how they are used (agents: `engine/lib/agent-usage.ts` on the backend), each item's parts opening on the
  right like files. Built-in procedures open read-only; "Make my own copy to edit" saves a copy under the same id.
- **Checks live on what they check** (Studio, `~/.claude/plans/studio-layout.md`): there is no all-checks page. A
  check shows on every agent, tool and procedure page it touches, worked out by `checks/lib/check-subjects.ts` from its
  agent, hand-offs, procedure (a step check's `step.from`), and the tools it expects or calls. One shared list
  (`features/checks/components/CheckList.tsx`) takes the scope; "New check" starts as a check of that page's subject.

## The bench

Level 2 scenarios also run on their own, when the model is idle (`BenchService`, `checks/lib/bench.ts`).
Top-level runs report start and end; `BenchIdleWorkflow` counts the owner's idle minutes down from
the last event. When the time is up, everything runs if the last full run is older than the setting,
otherwise only the scenarios of agents whose fingerprint changed. A scenario that passed last time and
fails now is a regression: it is recorded on the run, shown as a toast, and marked in that check's history. Settings
live on Infrastructure → Running, beside the bench's Pause switch (when it starts after the model goes idle, and how
often everything runs).

## The sidebar

Koala (chats), Projects, Studio (Agents, Tools — one explorer of tools, MCP servers and workspace dependencies, `engine/components/Studio/toolbox.tsx` —, Procedures, Tree Types, Extensions, and **Models**: the LLM
providers and the default model, `models/components/ModelsView.tsx`; **Connect OpenRouter** signs the person in to OpenRouter and gets a
key on their own account and bill by OAuth PKCE, `models/lib/openrouter-connect.ts`: the verifier only in a sealed, httpOnly
cookie bound to the person, the state checked before OpenRouter is asked, the key stored like a pasted one, which stays
possible), Infrastructure, My Machines (machines Koala works on),
Cloud providers (cloud credentials) and Settings (account, 2FA, addresses, notifications, backups, people and invites).
Three pages are off it and reached where they are used: the VPS catalog through Compare plans in Provision a cluster,
Nginx through Local router on the system cluster's page, and Temporal through All workflows on Running. Each still
answers at its old address.

## Infrastructure (one page for clusters, apps, services, monitoring and running work)

Plan: `~/.claude/plans/infrastructure-page.md` (and `monitoring.md` for the health part). Sidebar → **Infrastructure**
(`features/infrastructure/`, `#/infrastructure`, with Running's count badge) replaced Clusters, Applications, Services,
Monitoring and Running. It is one page of sections, no tabs; the old addresses (and `#/infrastructure/apps|clusters|running`)
scroll to the matching section:
- **Needs attention**: what needs attention, worst first — work **waiting on the person** (a tool call to allow, or a Wait for
  Person step: `waitsFor` in a run's state query, so a release waiting on its card or a workspace build asking to install
  shows), apps and clusters not healthy, **broken workloads** on any cluster they can see, firing alerts, and **work that
  failed in the last 7 days** with Clear.
- **Apps**: every deployment with its health numbers, its addresses, Manage (the app's dashboard) and Destroy; Deploy an app.
  **An app's name is unique per owner, not across everyone** (the `deployments` index is `{ ownerId, name }`): a deployment's id is its own, and its namespace is `<name>-<six characters of its id>` (`newAppNamespace`), so two people's `shop` never share a namespace on one cluster. Every read of a deployment's namespace goes through `namespaceOf` in `infrastructure/lib/app-namespace.ts`, which falls back to the sanitized name for apps deployed before namespaces were stored. `npm run test:app-names-live` proves it.
- **Clusters**: every cluster as a card (health, use, apps, history kept), Logs and Destroy (the system cluster
  read-only); Provision a cluster.
- **Running**: what runs, cancel, the bench and memory keeper switches (below), and All workflows (the Temporal page).
- **Your own hardware**: a machine joining the mesh (a single-use key and the join command), to become a cluster
  through Provision a cluster, and the machines on the mesh.
- **Model traffic**: each model's queue, whether it is answering or paused because its server said it is busy, and its totals.
- **Koala**: what Koala reports about itself (`KoalaSection`, `koala` on `GET /api/infrastructure`): its state, which of its
  processes report, requests and the share failing, model calls, their failures and queue, workflows started, activities
  and work that failed, read from the system cluster's Prometheus through the named questions in `koalaQuery`
  (`monitoring-questions.ts`) and judged by `koalaVerdict` (`monitoring-summary.ts`); what is not measured is said so.
- **Alerts set** and **Alert history**.

An app's page (`#/infrastructure/app/<id>`) is its health; a cluster's (`#/infrastructure/cluster/<id>`) is its health
plus **everything on it** (`ClusterContentsService`, `GET /api/infrastructure/clusters/:id`): every workload, read with
kubectl and judged by `infrastructure/lib/cluster-workloads.ts` (crash loops, image pulls, waiting for room, restarts in the last hour,
failed jobs; finished jobs left out; memory and CPU from Prometheus when it answers), grouped as the person's apps,
Koala's work (sandboxes, release slots, builds; a namespace a check's space left is marked so), the platform, and
anything put there another way; then the platform services (`infrastructure/lib/platform-services.ts`, with Open dashboard and how each signs you in), nodes,
GPUs and Helm releases. Whoever owns the cluster sees all of it; anyone else sees only their own namespaces (their apps,
`koala.dev/owner`), and no services, nodes or releases. Reads are cached per cluster for 20 s. The same rule (`clusterOwnership` in
`platform/lib/ownership.ts`, which monitoring uses too) guards the dashboard proxies (`/api/clusters/:id/proxy/<service>`, which sign
in as admin) and `/api/clusters/:id/gpu-status`: anyone but the owner gets the 404 an unknown cluster gets, and Open in Grafana shows only to the owner.

**Failed work** (`WorkFailureService`, `workFailures`): a top-level run that ends `failed` (from `run-ended`, never a
check's space), and any workflow Temporal closes as Failed or TimedOut (polled every 30 s; deploys and provisioning are
left out since their failure shows on the app or cluster), described the way Running describes it, shown 7 days, kept
30. `GET /api/infrastructure` puts the overview together (`InfrastructureViewService`); `POST /api/infrastructure/failures/clear`.

Each app and cluster also keeps its **Health** tab in AppDashboard: charts over an hour, a day, a week or a month
(uPlot, loaded lazily), with release markers, its alerts and alert history, and "Open in Grafana".

**One set of named questions** (`monitoring/lib/monitoring-questions.ts`) is asked of each cluster's Prometheus through
`ClusterProxyService`; the browser never sends PromQL. `monitoring/lib/monitoring-summary.ts` turns the answers into states and the
plain lines Koala reads, and `MonitoringService` serves both (`/api/monitoring`, `/apps/:id`, `/clusters/:id`, `/alerts`,
`PUT /clusters/:id/history`, `DELETE /rules/:id`). What isn't measured (an app with no probe, requests where Traefik doesn't
count them) is said to be unmeasured, never shown as fine.

**Koala** holds `monitoring_overview` (which ends with a "Koala itself" line), `app_health`, `cluster_health` and `propose_alert` (extension `monitoring`).
- An alert is a template (`down`, `slow`, `memory`, `restarts`, `volume`, `errors`; `monitoring/lib/monitoring-alerts.ts`) proposed
  on a card (`set_alert`). Three more are about Koala itself (`koala_down`, `model_errors`, `workflow_failures`,
  `KOALA_ALERT_KINDS`, expressions over Koala's own metrics in `koalaAlertExpression`): proposed with `app: "koala"`, only
  by whoever owns the system cluster, and written as a PrometheusRule into `monitoring` there; their rule records carry
  `deploymentId: 'koala'` and their alerts are `about: { kind: 'koala' }`.
- Applying it writes a PrometheusRule into the app's namespace, labelled `koala_rule`, and records it
  (`monitoringAlertRules`).

**Alerts reach the person.** `AlertWatchService` reads every cluster's `/api/v1/alerts` every 30 s. Each person sees
their apps' alerts, their own rules, and machine alerts on clusters they own; never Watchdog or k3s's false positives.
A new one becomes an episode (`monitoringAlertEpisodes`) and is told once, as a toast and a notice: in the project's
channel, or the conversation the rule was proposed in. Its resolution is told the same way.

**The watcher also reconciles each cluster**, at most every 10 minutes:
- **History:** Prometheus keeps its data on a volume, for the days the person set per cluster (10 by default,
  `monitoringSettings`). This is applied with `helm upgrade --reuse-values` at the chart's version, with a
  `retentionSize` under the volume.
- **Request counts:** each app's requests are counted. Our Traefik gets `addServicesLabels`. On a cluster that keeps
  k3s's Traefik, a `HelmChartConfig` turns it on, unless the person has one of their own, which is never overwritten.

`mechanics-monitoring` (off the bench) proves the read → card → rule path with a real app deployed for the check's space
(`world.apps`, expectation `alertRules`); `npm run test:monitoring-live` proves an alert of the person's own firing and
resolving, on their own model.

## Email (alerts by email, self-hosted)

Root sends its own mail. `docker/mail` is a send-only Postfix with OpenDKIM (`docker-compose.mail.yml`, host network,
listening on `127.0.0.1:2525`, trusting only loopback):
- It signs as `<domain>` with selector `koala`; the key is kept in a volume.
- `MAIL_RELAYHOST` sends through a smarthost instead, for a host that blocks port 25.

`bootstrap.sh` sets `MAIL_SMTP_URL=smtp://127.0.0.1:2525`. `scripts/root-node/mail-dns.ts` (rules in `platform/lib/mail-dns.ts`)
makes the A, SPF, DKIM and DMARC records through Cloudflare. It never rewrites a record the person made, and says what is
left to do by hand: PTR, and their own SPF. `update.sh` keeps the container current.

**Who sends** (`emailWayFrom` in `platform/lib/email-way.ts`, `MailService`):
- **Root or combined:** Nodemailer to `MAIL_SMTP_URL`, from `MAIL_FROM` or `alerts@<INGRESS_DOMAIN>`.
- **An instance** never sends itself. It posts to root's `POST /api/instances/mail` with its credential, and root sends
  only to the instance owner's address. Subjects are one line.
- **Without either,** email is off and Settings says why.

**Settings → Notifications** (`NotificationService`, `/api/notifications`, `notificationSettings`): every alert (the
default), only "down" ones, or none, plus "Send a test email". `AlertWatchService` emails each alert as it fires and as
it resolves, alongside its notice.

In dev, `docker compose -f docker-compose.mailpit.yml up -d` and `MAIL_SMTP_URL=smtp://127.0.0.1:1025` in
`apps/backend/.env` catch every email at http://localhost:8025.

`npm run test:mail-live` proves the container signs mail that verifies (DKIM checked with `mailauth`) and refuses to
relay for anyone else. `test:routing-live` proves an instance's email reaching its owner through root.

## What runs (Infrastructure → Running)

**Running** (`features/infrastructure/components/RunningSection.tsx`; its count is the sidebar badge) lists the person's running work in
plain words, from Temporal (their `KoalaOwner` workflows, top-level only; the conversation countdowns and the bench's
idle timer are left out) mapped by `infrastructure/lib/running.ts`: the bench and checks (progress from the check run), the memory
keeper (what it reads, from the run's memo `about`), tree runs, releases (and whether one waits on the card), chat turns
(the memo's `agent` and `conversation`, written by the run starter), workspace builds, deletions and deploys; an unknown
type is listed by its type. Each opens where it lives and is cancelled its own way (`RunningService`: a check run's
`cancelCheck`, a tree's `stopRun`, a run's `cancelRun`, otherwise a Temporal cancel); what cannot stop part way
(deletions, an approved plan, saving a workspace) says why. Two switches pause **the bench** (its own `enabled`) and **the
memory keeper** (`keeperSettings`): a paused keeper holds each conclusion in `deferredConclusions`, in order, and hands
them all over when resumed (`MemoryKeeperService.setPaused`). API: `GET /api/running`, `POST /api/running/:id/cancel`,
`PUT /api/running/bench|keeper`.

## Koala's own telemetry

Plan: `~/.claude/plans/koala-telemetry.md`. Every Koala process measures itself with OpenTelemetry and sends it to one
place: the **OpenTelemetry collector on the system cluster** (`otel-collector` in `monitoring`, ClusterIP only), which
exports traces to **Tempo** (`tempo`, a week on a volume) and serves metrics for the cluster's **Prometheus** to scrape
(a ServiceMonitor; no change to the kube-prometheus-stack release). Both are part of the observability stack
(`constructs/telemetry.ts`, `constructs/koala-dashboards.ts`): `monitoringPlan` applies that stack again when either
service is missing, exactly as it does for a missing blackbox exporter, so a cluster from before gets them when its
cluster worker starts or its next app is deployed. Grafana gets a Tempo datasource and three dashboards (Koala: the
service, Koala: model calls, Koala: Temporal).

- **Starting it.** `startTelemetry` in `@koala/engine-core/telemetry-sdk` is the first thing the backend
  (`koala-backend`), the three workers (`koala-worker-host|cluster|engine`), the in-process stream worker's activities and
  the machine agent (`koala-machine`) do. `platform/lib/telemetry.ts`'s `telemetrySettings` names the service, the role
  and the instance. Without `OTEL_EXPORTER_OTLP_ENDPOINT` the SDK records but sends nothing; the backend and workers then
  reach the collector the way they reach Prometheus (`collectorSink` in `monitoring/services/CollectorReach.ts`:
  `ClusterProxyService.serviceUrl`, direct ClusterIP or a port-forward, asked again at most once a minute while it
  fails), so `npm run dev` needs nothing set. On root, `bootstrap.sh` and `update.sh` start a host collector
  (`docker-compose.otel.yml`, `docker/otel/config.yaml`: OTLP on 127.0.0.1:4318, Caddy's per-host request metrics scraped
  from its admin port) that relays to the cluster's collector, and set `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`.
  A machine never reaches a collector: its agent sends batches over its socket (`telemetry:export`, `telemetry-sink.ts`)
  and the backend relays them (`machines/lib/machine-telemetry.ts`, at most 4 MB a batch) to the collector it reports to.
- **No deadline, never in the way.** The SDK batches (`BatchSpanProcessor`, a metrics reader every 15 s), its sink
  reports success at once and sends in the background with one send in flight per signal; a collector that is down costs a
  request nothing: the batch is dropped and it is logged once (`logOnce`), once more when it answers again. Nothing waits
  on telemetry, nothing is retried.
- **What is measured** (`KoalaMetrics` in `@koala/engine-core/telemetry`, every name `koala_*`): `koala_up` from every
  process; HTTP requests by route template and status (`koala_http_request_seconds`, the same series `/api/metrics` serves);
  workflows started by type; activities by type and outcome, retries and late heartbeats; model calls by provider, model
  and outcome, tokens, queue wait, 429 pauses, lost connections and the queue depth; tool calls by tool and outcome;
  sandbox provisioning and image builds; each hub sync step; emails sent; failed work by kind; telemetry relayed from
  machines. **Traces**: a span per request (`MetricsService.middleware`, named `METHOD /route/:id`, the trace id answered
  in `x-trace-id` and taken from an incoming `traceparent`), `workflow.start <type>` (the Temporal client interceptor
  `traceWorkflowStarts`, which puts `traceparent` in the start headers), `activity <type>` on every worker
  (`traceActivities`, the trace read from the activity's headers), `model.call`, `tool.call`, `sandbox.provision` and
  `image.build`. Inside a workflow the pure interceptors in `workflows/telemetry-interceptors.ts` copy the trace headers
  onto every activity, child workflow and continue-as-new, so one trace follows a request into the worker and back out;
  `carryingTrace` puts the active trace on an axios client (the check runner's), so a check's whole run is one trace.
- **Nothing a person typed enters telemetry.** No prompt, message, reply, thinking, tool argument, tool output, file
  content, secret or token goes in a span name or attribute, a metric label or a log line: ids, counts, durations, model
  and tool names, route templates and status codes only. `telemetry-scrub.test.ts` feeds all of those through a model
  call and a tool call and asserts none reaches the sink. A span records an error as its type, never its message.
- **Adding a metric or a span.** Add the instrument to `instrumentsOn` in `packages/engine-core/src/telemetry.ts`
  (counters without `_total`, which the collector adds; histograms of seconds take `SECONDS_BUCKETS`) and record it with
  `koalaMetrics().<name>` where the thing happens; wrap work in `withSpan(name, attributes, run)`. Browser-safe code
  (agent-engine, which the frontend bundles) imports only `@koala/engine-core/telemetry`, the API; a process imports
  `./telemetry-sdk`. To show a new number on the Infrastructure page, add a question to `KOALA_QUESTIONS` and its PromQL
  to `koalaQuery`, a line to `koalaLines`, and a figure to `koala-figures.ts`.
- **Env**: `OTEL_EXPORTER_OTLP_ENDPOINT` (a collector to send to; unset, the cluster's is found), `KOALA_VERSION` (the
  service version on every span and metric), `OTEL_CLUSTER_COLLECTOR` (root's compose only: the cluster collector's
  address the host collector relays to).
- `npm run test:telemetry-live` proves the whole path on the running dev stack.

## Platform keys

Four keys, one per purpose, loaded once by `platform/lib/keys.ts`'s `loadKeys(process.env)`:
- `SESSION_KEY` signs session cookies;
- `DATA_KEY` encrypts every stored secret (`crypto.ts`);
- `PAYLOAD_KEY` encrypts Temporal payloads;
- `EGRESS_KEY` derives the egress proxy's passwords.

Production refuses to start without all four. Dev derives any missing one from `JWT_SECRET`, so
nothing needs setting up. Never pass a raw env var where a key is wanted: take it from `loadKeys`.

Ciphertext carries the id of the key that wrote it (`v2:<keyId>:…`). Each keyring holds the current
key and any previous ones; previous keys only decrypt, and anything new is written with the
current key. `JWT_SECRET`, the old single key, stays on the ring as a previous key until it is
removed from `.env`.

Rotate with `npm run keys -w apps/backend`: a dry run that reports what would move. Add `--write-env`
to generate missing keys and `--apply` to re-encrypt Mongo and the key files in `data/`. Remove
`JWT_SECRET` only after `--apply` reports nothing unreadable and no workflow started before the
rotation is still running.

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

In-cluster worker lifecycle: `ensure-cluster.sh` creates the k3d management cluster (`provisioning-lunorica`) → the root `Dockerfile` builds the one app image (`nowrinkles/app`; `docker/entrypoint.sh` picks `backend`, `worker-engine`, `worker-cluster` or `worker-host`) with every workspace, kubectl, helm, k3d and terraform → `kubectl apply -f k8s/` creates ServiceAccount/ClusterRoleBinding/Deployment → the pod reads its service account and sets `K8S_HOST`/`K8S_TOKEN`/`K8S_CA_CERT` for CDKTF → mounts `/var/run/docker.sock` for docker-exec-based kubectl/helm into k3d server containers.

`AppStack.fromEnv()` (CDKTF) reads `KUBECONFIG` or `K8S_HOST`/`K8S_TOKEN`/`K8S_CA_CERT` for cluster auth.

## Temporal sync architecture

MongoDB stays in sync with Temporal via two mechanisms:
1. **`trackWorkflow()` polling** — every 5s per workflow; retries transient Temporal errors up to 12 times before giving up (avoids clusters getting stuck "provisioning" during brief Temporal outages).
2. **Background reconciliation loop** — every 30s, scans clusters in intermediate states (`provisioning`, `destroying`), checks Temporal directly, and updates MongoDB if the workflow finished but the DB missed it. Also parses log files to update `ClusterMetadata.progress` (e.g. `creating-cluster`, `patching-storage`, `deploying-cdktf`, `installing-traefik`).

**Nothing has a deadline; things end when they finish, fail, or are stopped.** Every activity takes `LIVE_ACTIVITY`
(`platform/lib/activity-liveness.ts`): the 30-day `startToCloseTimeout` Temporal requires, and a one-minute `heartbeatTimeout`.
Every worker (host, cluster, engine, stream, a machine's device worker) heartbeats every activity while it runs
(`heartbeatWhileRunning` in `@koala/engine-core`), so a dead worker is noticed in a minute and the activity runs again
elsewhere, while a slow one is never cut off. Helm and `kubectl --wait` take `CLI_CEILING` (720h) for the same reason.
No wait inside an activity watches a clock: it ends on the thing it waits for, on a state that will never recover
(`assessWorkload` in `infrastructure/lib/workload-health.ts` — `ImagePullBackOff`, `CrashLoopBackOff` and the like), or on a stop. The
pieces that used to cut work off and no longer do:
- **Model calls** go out through `patientFetch` (`agent-engine/src/model/patient-fetch.ts`): Node's `fetch` with an
  undici `Agent` that has no header or body timeout, so a long prefill or a slow stream is never dropped at 300 s. A call
  whose connection is lost (refused, reset, the stream cut off) waits until the server answers `/models` again, with no
  deadline, and asks again from the start, telling the run with a notice (`callModel`, `onConnectionLost`). TabbyAPI's
  liveness probe checks only that its port accepts connections (`constructs/tabbyapi.ts`): its `/health` shares the thread
  that generates, so a busy server used to be killed mid-answer. The
  per-endpoint queue (`model-rate-limiter.ts`) waits for its turn with no deadline and leaves when the run is stopped.
- **Commands.** `run_command`, Code steps, task checks, browser tests and every `kubectl` the engine runs have no time
  limit unless the caller sets one (`timeoutSeconds`, a step's "Stop after"). In a cluster workspace every command runs
  in its own process group (`GROUPED_EXEC` in `cluster-backend.ts`), so a limit or a stopped run kills everything it
  started (`STOP_GROUPED_EXEC`). Commands on a person's machine wait until the machine answers or disconnects
  (`local-agent-registry.ts`).
- **Sandboxes** last as long as their run (`sleep infinity`, no `activeDeadlineSeconds`) unless the run sets a time
  budget. The engine worker's sweep removes only sandboxes whose run has ended (`runEndedVia`), never by age.
- **People.** Wait for Person and tool approvals wait until someone answers or the run is stopped; a step may still set
  "Stop waiting after". A run takes each answer once (behind the `answers-taken-once` patch), so a procedure that
  comes back to the same question asks it again.
- **Workload health** (`assessWorkload` in `infrastructure/lib/workload-health.ts`) counts restarts against a pod only when the last
  one was within the hour, and ignores a pod that failed and was replaced, so a deployment whose server was once
  restarted and is only busy now is not marked `unhealthy` (an unhealthy model drops out of the model list).
- **Builds and releases.** Workspace image builds, Odoo release jobs and rollouts, browser tests, pipeline builds and
  cluster provisioning wait for their work however long it takes.
`mechanics-long-command` proves a command outliving any old limit.

**A model going in circles is asked again, not stopped.** The overthinking guard (Model Turn's "Stop overthinking") cuts a
stream off when its thinking repeats itself; the step then asks again in place, showing the model the end of where it
was stuck and telling it to pick and act, or say what it cannot do (`circlingNudge` in the engine's `model/circling.ts`,
with a notice). It asks again while each attempt circles somewhere new, and stops the run only when one goes round the
same circle as the last (`sameCircle`). A check script can stream thinking with `think`; `mechanics-circling` proves it.

**Odoo browser tests.** `odoo-e2e --keep` leaves the throwaway Odoo served between runs (reused while `addons/` is
unchanged, upgraded in place when it changed, `--stop` ends it). Specs use `e2e/odoo.ts` (`releases/lib/odoo-e2e-helpers.ts`:
`signIn`, `openAction`, `fill`, `choose`, `addLine`, `save`, `press`, `smartButton`, `reportHtml`), whose `test` gives each
step ten seconds and attaches `page-at-failure`, an outline of the page, which `odoo-e2e` prints and `readE2EReport`
keeps as `E2ETest.page` (task checks and the release card show it). The image carries the helpers and `odoo-e2e` copies
them into a repository that lacks them. Specs sign in as `koala-e2e`, made with the admin's rights and Odoo's onboarding
tours switched off (`tour_enabled`), since a tour starting on a new user's first form opens an error over it.

**Workspace images can be product images.** A tree works in the image its type's `language` names. The engine's
image planner takes the host's bases (`extensions/workspace-bases.ts`: the UBI ones plus `extensions/odoo/`'s Odoo 18 and 20, each
with PostgreSQL 18 and `odoo-check`); a base may carry setup steps, and a `dnf` install falls back to `apt-get`
(`APT_NAMES` maps the names that differ). Workflow code must not import `workspace-bases.ts` — the engine's root export
pulls in `crypto` and `path`, which Temporal's workflow bundle refuses.

**A tree type can have versions** (`versions` on the type: what they are versions of, each choice's version and the
workspace it works in, and the default; `projects/lib/tree-types.ts`). The Odoo type offers Odoo 20 (`odoo-20`, the default)
and 18 (`odoo`). A tree records its `version` when it is made (`versionForNewTree`: the plan's `tree.version`, the New
Tree dialog's choice, or the default; one the type does not offer is refused), and it never changes. The tree works in
that version's workspace (`treeLanguage`, through `treeLanguageFrom`), its starter is rendered with `{{version}}`
(`FROM odoo:{{version}}`, manifest versions), and the planner reads the versions in `list_tree_types` and
`describe_tree_type`. A tree from before versions works in the type's own `language`; startup stamps it with that
version (`stampTreeVersions` in `seedAll`). The Studio keeps a type's versions when it is saved but cannot edit them.

**Workspace images are built from named dependencies** (plan `~/.claude/plans/workspace-dependencies.md`). One catalogue
(`extensions/workspace-dependencies.ts`: node, python, go, jq, chromium-libraries, playwright, koala-e2e, playwright-mcp; each person's own in
`workspaceDependencies`, Studio → Tools, under Workspace dependencies, `/api/workspace-dependencies`, `WorkspaceDependencyService`) says how each installs (`onDebian` for an
apt base), what programs or libraries it puts there and what it needs first. Everything names what it needs: a tool (`needs`), an MCP server
(`runs.needs`), a procedure step (`needs` on its `HostOperation`, resolved onto the agent by the directory's `stepNeeds`), a check (`checksNeed`: an
`e2e` check needs `koala-e2e`), the project's `.koala/workspace.json` (`needs`) and a base (`has`). `planImage` resolves them in order, once each,
skipping what the base has, and every planned image ends with a proof run as uid 1000 that each dependency put in what it promised (`proofScript`; a
broken promise fails the build naming it). Approving a plan or story change, accepting a task, or retrying a story adds what its checks need to
`.koala/workspace.json` and starts the build (`check-needs.ts`): unfinished tasks wait, a story whose finished work's checks need it is parked, and the
published build puts them back. A person's own dependency with a script waits for approval like a project script. Startup moves stored inline
installs onto dependencies (`engine/lib/dependency-migration.ts`). `koala-e2e` outside Odoo runs the project's own Playwright with its playwright.config
webServer (`engine/lib/browser-tests.ts`); `mechanics-workspace-needs` proves the whole path. In-cluster addresses skip the egress proxy (`NO_PROXY`).

**A tree's workspace is composed, built and published.** Plan: `~/.claude/plans/workspace-tool-servers.md` (step 0).
- A project says what its workspace needs in `.koala/workspace.json` on `main` (`engine/lib/workspace-file.ts`: packages by
  manager, an install script, languages, plain env values — a secret-looking name is refused).
- One composer (`engine/lib/workspace-composition.ts` → the engine's `planImage`) puts the tree type's base, that file and the
  tools of every agent that works in the tree into one plan, each line saying where it came from (`PlanLine.from`).
- The image a tree works in is its **published workspace** (`publishedWorkspaces`, `engine/lib/published-workspace.ts`): the
  file it was built from, its image, lines and env, and `next` (how far the next build has got). A tree with none is
  composed from `main` and published the first time it is wanted. Later runs compose from the published file, so an
  agent gaining a tool is still picked up, but a new `main` waits for its build.
- A pod carries `koala.dev/workspace` (`workspaceStamp`). A tree pod whose stamp differs is replaced at the run's next
  command, with `/work` kept (`currentWorkspace` in `environments.ts`).
- **Builds are the `build-workspace` procedure** (`extensions/workspace/`, agent `workspace`, no model): read →
  compose → (a new install script waits on Wait for Person with Install it / Do not install) → build → publish →
  resume → tell the channel. Any failure keeps the workspace the tree had. It runs once per tree and commit
  (`workspace-build-<tree>-<commit12>`). It is started by a push to `main` that touches the file (the Gitea webhook →
  `WorkspaceBuildService.pushed`) or by `change_workspace`. A notice a procedure step emits with `post` goes to the
  project's channel (`StreamServices.post`), and a Wait for Person with `choices` takes no other answer.
- **Agents ask with `change_workspace`** (executor, planner, Koala). It commits the addition to `main` straight away,
  not to the leaf's worktree: a story that needs a package cannot be verified without it, so it would never land. It
  then starts the build. The tree comes from the call's workspace (`caller.treeId`, for a run in `tree-<id>`), the
  chat's binding, or `treeId`.
- **A task waits with `mark_waiting`** (executor). It is refused while `main` has nothing the published workspace
  lacks (`pendingChanges`). do-one-task reads the task's state when the model answers (`task_status`) and ends the
  run there, judging and recording nothing, if it waits. When only waiting tasks are left, Next Task leaves through `waiting`. The story is parked
  (`waitingFor` on the leaf, still `pending`): it is not failed, not replanned, kept out of `ready_leaves`, and shown
  as Blocked on the board. `workspace.resume`, after a publish, clears it, sets its waiting tasks to `accepted` and
  grows the tree. A story is parked only after its run ends, so parking asks the workspace first (`parkingFor`): a
  build already published puts it straight back in line, and one that failed or was declined marks it `stuck` (as
  does a build failing later; the next build clears it), which the board shows and `settleTree` fails on.
- A `pip` or `npm` line on a base without that manager installs its language first (`withManager` in `planImage`).
- A run in a tree's workspace is told what is coming that it does not have yet, and at what stage
  (`RunWorkspace.coming`, `stageText`).
- **The person edits it on the tree's Files page, in its Workspace section** (`TreeWorkspaceFilePanel`,
  `TreeWorkspaceService`, `GET`/`PUT /api/trees/:id/workspace-file`): the file on `main` as a form, every line it
  composes to with where it came from (lines `main` has that the published image lacks are marked), the published
  image, the next build's stage and the last builds. Saving commits to `main` as the person and starts the build,
  the same run a push would. Workspace notices open it (`open-workspace`). Check stages `editWorkspace` and
  `waitWorkspace` do the same through the API.
- Extension tools reach the tool runtime through the same runtimes as their operations (`extensionRuntimes` once in
  the host); `engine-host/host.test.ts` fails if a grove or workspace tool has no handler there.
  `mechanics-workspace-change` proves the whole path, with the check stage `settleTree` waiting for the story the
  build puts back in line.

## Odoo projects: A/B releases

**How a project's builds are released is a procedure.** A tree type says it in `release: { agent, app }`, and a
project may override it (`releaseHowOf` in `releases/lib/release-run.ts`: the project's setting, then its type's, then a chart in
the repo means `slots`, otherwise `replace`). The `releases` extension (`extensions/releases/`) holds the steps and three
procedures, run by agents with no model:
- **`slots`** (agent `release`, the Odoo type's): the first build goes into slot `a` (the init job creates `odoo_a` before
  slot a's Odoo exists — an Odoo started with `--database X` initialises X itself, so a slot's Deployment must never exist
  while its database is prepared); each later build is prepared in the idle slot from a copy of the live database and
  filestore, quieted, upgraded (`-i` new modules, `-u` the rest), **compared with live** (Compare With Live,
  `releases.compare`), its browser tests run, and it waits on Wait for Person (`decide`: Cut over / Discard / Run tests
  again), answered by the release card (`/api/projects/:id/releases`). The comparison (`releases/lib/release-compare.ts`, kept as
  `changes` on the release) reads both slots' schemas through the adapter's `database`
  (`extensions/releases/postgres-compare.ts`): tables and columns the upgrade drops with how many rows held data, and
  columns whose type changes (Odoo keeps the old values in `<column>_moved0`); and the adapter's `inventory` of what was
  made or edited in the app (Odoo, `extensions/odoo/inventory.ts`: fields and models made in the app, views made or
  edited in it, server actions, automations, reports, email templates), each kept, reset, switched off or gone. Names,
  counts and hashes only, never business rows. **When it would lose something the run waits on `decideLosing`
  instead** (Cut over, losing what is listed / Discard / Run tests again), the API refuses a cut over without
  `confirm: true`, naming the losses, and the card shows them under "What this release changes". Switch Slots compares
  once more on the final copy and stops the cut-over, serving the live slot again, if anything the person was not shown
  would be lost. Cutting
  over puts the live slot in maintenance, copies and upgrades again, then switches `live`; the old slot is stopped with its
  database untouched as the way back. What is Odoo about it is the app's adapter (`extensions/odoo/release-adapter.ts`).
- **`slots-roll-back`** (agent `release-roll-back`): offered on the live release once its run has ended and until a later build reuses that slot,
  it starts the kept slot, waits for it, then switches `live` to it — the app returns to the snapshot taken at the
  cutover, so anything entered since is lost, and the confirm says so.
- **`replace`** (agent `release-replace`): an image project's build deployed in place of the running app through the
  same deploy the backend uses (`infrastructure/services/AppDeploy.ts`); the backend's reconcile loop follows a deployment whichever
  side started it.

`OdooReleaseService` starts one release run per build (`release-<projectId>~<stamp>`, bound to the project), one at a
time per project: a build arriving while a preview waits stops that run, whose cleanup (Settle Stopped) clears and sets
the preview aside; one arriving while a release is prepared waits as `queued`, and the newest queued build goes next.
The steps write the release records; the service follows them and the run, and tells the person: each release records when it was last told (`toldAt`), so a change is told once, whichever process sees it, and one that happened while the backend was down is told when it starts (`release-told-at` stamps releases from before). The cluster is the
truth for which slot is live (`helm get values`); releases are records (`odooReleases`). Each project's release has
a deployment record (`appType: odoo-project`, with its `namespace`), so it shows among apps, goes with the project, and destroying it
uninstalls the release and its namespace. A release is named once, at its project's first release: the project's name plus a
short hash of its id (`newReleaseName`), stored as `releaseName` — so two projects with the same name never share a
namespace or a host, and renaming a project does not orphan its app; a project released before names were stored keeps
the name it has. Its namespace is labelled `koala.dev/owner` and `koala.dev/project` before Helm installs into it. Releases reach clusters the way `ClusterService` does
(`activities/cluster-access.ts`'s `reachCluster`). Exposing the app also exposes its preview on its own address, and
the project's builds panel shows the releases with a card to cut over or discard a waiting one. `npm run test:odoo-release-live` proves it on the system cluster with
a throwaway project, ~4 min, and removes everything.

**A release's build can be released again** (Release this build again on its card, `POST /api/projects/:id/releases/:rid/again`,
`OdooReleaseService.releaseAgain`): the same image prepared afresh in the idle slot from a fresh copy of live, without asking
whether anything changed, recorded with `again`; a waiting preview is set aside as a new build would. Each release on the card
says whether it brought **new code** or an image already released (`release-kind.ts`), and lists the **files it changes** since
what is live (a live one: since the release it replaced), each with its diff, the files the app is built from (the type's
`releaseWhen`) apart from the rest of the repository (`GET …/releases/:rid/files`, `releases/lib/file-changes.ts`, the diff read with
git through a read token, `ProjectRepoService.diffCommits`).

**What was made in the live app can be brought into git** (`CustomizationsService`, `releases/lib/app-drift.ts`). The project's
Settings lists it under "Made in the live app" (`GET /api/projects/:id/customizations`, the adapter's `inventory` on the
live slot), and Koala reads the same with `app_drift`. "Bring into git" (`POST …/customizations/adopt`) or Koala's
`propose_adopt_customizations` puts a card in the project's channel: a story in the tree's feature "Customizations from
the live app" (opened on approval: `newBranch` on the change), or for a project with no tree, a plan for one holding that
story. Its worker calls `export_customizations` (granted to the executor), which reads the items from the live slot and
writes `addons/<project>_customizations` exactly (`extensions/odoo/export.ts`: each record with its stored fields, every
reference by XML id, an edited module view kept under its original XML id, refused whole when something cannot be named),
with `adopt.json`; then `odoo-check` and the story lands. When a build first installs that module, the Odoo adapter's
`upgrade` links each record in `adopt.json` to its XML id in the slot's copy before `-i`, so Odoo takes the live records
over rather than making them twice; the release's comparison then shows them kept, and they no longer count as made in
the app.

**A project can start from a client's own Odoo database** (`ClientImportService`, rules in `releases/lib/client-import.ts`).
While nothing is released, the project's Settings offers "Start from a client's database": the zip Odoo's database
manager makes (`dump.sql`, `filestore/`, `manifest.json`), as a neutralized copy (the default) or as their live system.
`PUT /api/projects/:id/import?mode=copy|live` streams the body (never buffered; the HTTP server has no request
timeout) through `kubectl exec -i` into a volume claim `<release>-import` in the release's namespace, via a busybox holder
pod, then reads `manifest.json`: a backup from another Odoo version (or hosted Odoo's `saas~` versions) is refused there
and deleted. The upload is recorded on the project (`clientImport`) and the newest build released, or the first build
when it comes. That first release (`restore` on the build input, carried by `OdooReleaseService` while nothing is
established) runs the adapter's `restore` in place of `init`: one job in the build's image checks every module in the
manifest exists in the image (refusing with the list, `missing modules: …`), loads `dump.sql` into `odoo_a`, unpacks
the files, and for a copy runs `odoo neutralize` with a fresh database uuid and secret; then `upgrade`
installs the repository's new modules and updates only those whose version differs from what the client has
installed (`moduleChanged`), since `-u` would reset what they edited in that module's views (with step 4's takeover). `admin`'s password is then Koala's sign-in. The service
settles `clientImport` from the release (imported, refused with the missing modules, failed), and the channel's notice
says how it started and how many things were made in the client's app (Settings → Made in the live app, Open settings).
`npm run test:odoo-import-live` proves it: a backup made with `odoo db dump` from one project's live app, refused for
another version and for a missing module, restored as a copy and as live, ~25 min, removes everything. Importing from
hosted Odoo (Online, Odoo.sh, Enterprise) is a later step.

**Koala settles a new client project before planning it** (release patterns step 5). Koala holds `list_tree_types`
and `describe_tree_type`; for something new (no tree or project bound) it asks, in one message, only what the person
has not said: the type's version, says in a sentence how the type is released (and asks only when its HOW IT IS
RELEASED section offers another way), and, when the type has a STARTING FROM THE CLIENT'S OWN APP section, whether
the client already runs it. Both sections are written from what runs them (`TreeTypeDescriptions.releasing`: the
release agents from `releaseAgentsOf` that fit the type, and `restoringApp` from `RELEASE_APPS`). The plan's tree
carries `release` (one of those other ways; the type's own is dropped) and `startsFrom: 'client-database'` (refused
unless the type's app restores), checked by `parsePlan` against `PlanWorld.releasing`; the card shows both. Approving
applies them to the tree's project (`projectChoices` → `projectChoicesPatch`): its `release`, and `clientImport:
awaited`. While a project awaits its client's database, a finished build is held, not released (`releaseHeld`,
`HELD_FOR_CLIENT`), and the channel is told once (`awaitedNotice`, Open settings); uploading the backup releases the
newest build with the restore, and "Start without their database" (`DELETE /api/projects/:id/import`) sets the import
aside and releases it fresh. Checks can now assert what an agent said (`said`: `contains` exact, `means` judged by the
run's own model through `itSays`), the conversation's plan (`plan`), `clientImport`, `build.held` and `noticed`, and
wait with `waitBuild`; `story-odoo-client-project-scripted` proves the plumbing, `story-odoo-client-project` runs it on
the person's model (off the bench).

**A new tree that produces a service gets its own project** (`TreeHomeService`, rule in `projects/lib/tree-home.ts`): plan
approval (`homeTree` in plan adoption) and `POST /api/trees` both call it, so it does not matter whether the tree came
from chat, a check or the New Tree dialog. The project (`project-<treeId>`, so a retry finishes rather than doubles it)
gets a repository, the build webhook, the person's own cluster and auto-deploy (`ProjectRepoService.createProject`, the
one way a project gets a repository). The New Tree path also seeds the type's starter; adoption writes the starter with
the plan in one commit. A tree that produces an artefact gets no project. A build is pinned to the commit that was pushed
(`releases/lib/build-plan.ts`), and a push whose commit has no Dockerfile records no build at all.

**A tree type declares the secrets its app needs** (`secrets` on the type: a key, where it comes from — `generated` by the
platform, a minted `gitea-read-token`, or a `person` on a card — what it is for, and optionally the login it `signInAs`).
`ProjectSecretsService.ensure` puts them in the project's Infisical workspace when `TreeHomeService` makes the project, and
again before every Odoo release (`OdooReleaseService`) and image deploy (`TemporalBridge.promoteProjectBuild`), so a project
made before a type declared something catches up; a person-sourced one waits on a card on the tree's page and holds the
release. No value ever reaches a model, and leaf workspaces get none. Image deploys sync the vault into `<namespace>-secrets`
(the app's `envFrom`); an Odoo release syncs it into `<release>-vault` (`OdooReleaseVaultActivity`, before Helm), the chart
reads `POSTGRES_PASSWORD` from it, and the init and upgrade jobs set `admin`'s password from `ODOO_ADMIN_PASSWORD` every
time. A chart from before this (its repo still has `deploy/chart/templates/secret.yaml`) keeps its own database password,
which is copied into the vault on every release so the two never drift. An Odoo project no tree is the home of uses the
release's own list (`ODOO_RELEASE_SECRETS`). The person sees a sign-in with "Show sign-in" on the project's card
(`GET /api/projects/:id/sign-in`, uncached, read from the vault to their browser); the planner reads the list in
`describe_tree_type`, and the Studio edits it under a type's Secrets.

**A tree type also says what its app depends on, what its leaves get, and what makes a release.** `defaultBindings`
("Depends on" in the Studio) are seeded into a new project's `needs`, so every deploy binds those services into the
app with their credentials; the tree's workspaces get network access to them only (`treeExtrasFrom` → `extrasOf` on
the tree workspace), along with the type's own `egress` rules and plain `env` values — never a credential, since a
model works there. `releaseWhen` lists the paths the app is built from: a push that changes none of them since the last
release (Odoo) or the deployed image (image deploys) still builds, but nothing is released, and the build says why
(`releaseSkipped`, `releases/lib/release-paths.ts`). A check's world can lay settings over a tree type (`world.treeTypes`).

**Every project has a channel, and the channel hears what happens to its work.** A project's channel is its own
conversation (`channel-<projectId>`, `kind: 'channel'`, `ProjectChannelService.ensure`, made with the project or the
first time its page opens, bound to its tree, deleted with it).

**A project opens on its board** (`features/projects/components/Board/`, `#/projects/tree/<id>` or `#/projects/project/<id>`).
Every tab (Board · Releases · Files · Settings) starts with **the strip** (`projects/components/Strip/ProjectStrip.tsx`): what is live
with Open app and sign-in; what is being worked with Stop, or how many stories are ready with Work them; what each agent runs
on (`runsOnLine`), opening the tree's models in place with **Every agent in this tree** (`wholeTreeChanges`) and auto mode;
and **Waiting on you**: a preview to cut over, cards, asks, secrets. A plan card about a story that has since finished is out
of date (`projects/lib/plan-staleness.ts`): listed as replaced and refused when approved. Releases holds builds and releases, Files
the explorer and editor, Settings the models, auto mode, workspace definition and sandbox. On the board
(full width, its chat a panel the strip's Channel button opens and closes, remembered per project, `useChatPanel`),
each tree as an epic with its features (branches) as rows and its stories (leaves) as cards in the state columns
(`BOARD_COLUMNS`/`stateFor`, the one rule for a leaf's column; `board.ts` builds it), and the channel on the right, its
width dragged (and kept) at the divider. Opening a card or a feature puts it on its own page in place of the board, with
breadcrumbs back up (`…/<branchId>/<leafId>`, `…/<branchId>`; each opening is a history step), and its chat on the right
beside the Channel and Threads tabs. You set the order work is taken in on the board: drag a card by its grip within its column, move a feature with its arrows (`PUT /api/branches/:id/order`, `PUT /api/trees/:id/order` → `priority` on stories and features, `GroveOrderService`); `ready_leaves` takes ready stories in that order (`projects/lib/work-order.ts`), so the fan-out starts yours first, and Koala's outlines list them in it. A story's page lists its tasks, with Accept and Drop for any proposed while it was worked, and "Watch it work" opens the live feed of its worker's run and the runs it starts (the tree run's turn, `turnId` on `GET /api/trees/:id/run`; `GET /api/turns/:id?under=<runId>` sends only that run's family, with `through`, the last seq it read). Each run is a tab (`projects/components/Board/StoryRun.tsx`): its procedure on the Studio graph, read-only, following and centring on the step it is on, and its rounds (`engine/lib/run-rounds.ts`: a round starts each time the model step is entered again, since the log has no `model.requested`; a tool the procedure calls itself, a `call-tool` trace, is shown apart from the model's). The turn log writes a step's node events when the workflow step ends, so the model call is only "entered" once it has answered; streamed thinking and text carry its node, and the run state takes the step from them. A `node.traced` event in the turn log is a summary (`tracedSummary` in `engine/lib/turn-log.ts`: no `inputs` or `outputs`); the full trace is only in `engineRunTraces` (`/engine/runs/:id/traces`, which checks read), and the Studio's run panel reads those every few seconds while a run is live. Each trace used to carry the whole conversation, which made a long run's log tens of MB and crashed the tab watching it. A story that can be started shows the tree's run panel on its page: there is no running one story, the tree takes the ready ones in board order. The editor, explorer, builds, workspace file and the tree's sandbox are its **Files** page (`…/files`); its models, auto mode, how its project releases and deleting the tree or project are its **Settings** page (`…/settings`, `projects/components/Settings/`); the switch at
the top. All three read the project through `useProjectWork` and keep the address with `useRouteSync`.

**A story and a feature each have their own chat** (`ItemChatService`, `POST /api/items/<story|feature>/<id>/chat`,
`story-<leafId>` / `feature-<branchId>`, `kind: 'item'`, bound to the leaf or branch and its tree, made the first time it
is opened). On every turn in it Koala is handed the item (`conversationBinding` → `story` / `feature`, written by
`projects/lib/item-outline.ts`): where it sits, its brief, what it waits on, its tasks, what was claimed, the judge's verdict and
the attempts that failed. Every chat bound to a project, a tree or one of its items is also handed the status of each of its projects — what is live, a preview waiting on the person, a release in progress, the last build (`projects/lib/project-outline.ts`). Every chat bound to something (a project, a tree, a feature, a story) opens with what Koala is handed on each
message, read fresh (`GET /api/conversations/:id/context`, `openingWith` over the same binding a turn gets;
`engine/components/Chat/ConversationContext.tsx`), formatted, with the exact text a click away. In a story's or feature's chat Koala changes the work only through a card: `propose_story_change` (title, goal, brief, waits-on, tasks, rework), `propose_stories` (new stories in a feature, or a follow-up to a shipped story, which is never changed) and `propose_story_cancel` make a plan proposal with a `change` (`projects/lib/item-changes.ts`), shown on the plan card in that chat, and nothing changes until it is approved. `AdoptPlanWorkflow` applies it: it first stops the worker of a story that must start again (a running story whose title, goal or brief changes or that is reworked; a claimed one has its claim set aside), saves the records, rewrites `leaves/<story>.md` and notes the change in PLAN.md, and runs the tree only when work was put back in line. A run a story was taken off can no longer claim it (`claim_leaf` checks the story's attempts). Cancelling frees the stories that waited on it. A notice about one story (a failed leaf) is posted in full in its chat and as one line with
"Open the story" in the channel (`line`, `open-story`); item chats are never a tree's threads and never hear the tree's
own notices. A check stage talks in one with `chat.in: { story: title }` or `{ feature: title }`, and approves a card there with `approvePlan: { in: … }`;
`mechanics-item-chats` proves it, change card included.
In the channel a message is just posted (`POST /api/conversations/:id/messages`, only channels) unless it names @koala or the person has turned on "Ask Koala" beside the message box (remembered per channel in their browser, `projects/lib/channel-asks.ts`); then it starts Koala's turn. Every person message in a channel says which it was ("asked Koala" if it carries a `runId`, else "posted · Koala wasn't asked" with **Ask Koala**, which starts a turn with `asks: <its at>` so that note is answered in place, never posted again; `openTurn` refuses one already asked about). A turn's history leaves out the message its own open turn is answering, since the opening already carries it with the context. In a channel or an item chat each person message in Koala's history says who wrote it (`heardAs`, by email), a channel post nobody asked Koala about reads "<who> posted, not to you:", and the binding's `chat` value tells Koala which chat it is in and who is asking (`chatFraming`), so it reads the discussion without acting on it. Other chats about the project are its threads. Approving a new tree's plan binds the
conversation it was planned in to the tree and its project. Releases (preview ready, live, failed), a tree's run ending
(and each failed leaf), and a secret only the person can enter post a notice — a third kind of message
(`role: 'notice'`, author `platform`, with links and actions) — to the project's channel (a tree with no project: to
the conversations bound to it), once per event (`ConversationNoticeService`,
`platform/lib/notices.ts`), pushed live as `conversation-notice`. Koala does not reply on its own; on the person's next message
it is given each notice as a message labelled "From the platform, not the person:". Koala reads trees and releases with
`read_tree`, `run_tree` and `project_releases`; a plan's tree starts growing when it is approved.

**A tree type describes itself** (`TreeTypeDescriptions`, `projects/lib/tree-type-description.ts`): what approving a plan makes
(`projects/lib/tree-home.ts`), the starter's files, the workspace image's own summary, how the tree grows — the grove agent's
procedure and the agents it hands work to, each in its own words (`outlineProcedure` in the engine) — and what happens
to work that lands (`projects/lib/delivery.ts`: the release text is keyed by every `ReleaseState`, so a new state must be described),
with what the platform owns so the plan must not. The planner reads it with `describe_tree_type`; the Studio shows it as
a tree type's "What it becomes"; the leaf judge is handed the type's `doneMeans`. Nothing in it is written by hand
except next to the code it describes.

**A grove lands what it verified, and says when it cannot.** `grove-run` lands verified stories after each judge pass and again when the tree goes quiet (`landWaiting`), so one that missed its landing is landed on the next run rather than stranded. Notices a step raises in the engine worker (a story that did not land, nothing landed this pass) come back with its result and are published into the run's turn log by `AgentRunWorkflow`; before, they never left the worker. Saving a workspace whose `main` was changed elsewhere (a person's edit in the editor, a merged pull request) no longer fails: the rejected push brings Gitea's `main` in, merges it, and pushes again; a real conflict is refused with the files that conflict and the workspace left as it was (`reconcileScript` in `workspace-documents.ts`).

**A tree's run is one workflow at a time, each run with its own id.** The workflow is `grove-run-<tree>` (so a tree
never runs twice at once, and Stop and deletion find it), but each run's id is `grove-run-<tree>~<stamp>`
(`groveRunId`), remembered in the workflow's memo (`RUN_ID_MEMO`, read back as the tree run's `turnId`). Child runs,
traces, turn logs and a task's `runs` derive from the run id, so a tree's second run never overwrites its first.
Anything that reaches a workflow by a run id goes through `workflowOfRun`.

**The browser hears when trees come and go.** Making or deleting a tree through the API, adopting a plan
(`AdoptPlanWorkflow`) and removing a project (`RemoveProjectWorkflow`) tell the owner's browsers `grove-changed`
(`notifyGroveChanged`; the workflows through `EngineGroveChangedActivity` on the stream queue, since the engine worker
has no socket, behind the `grove-changed` patch), and `useGroveChanges` refreshes the trees, stories and projects, so
the sidebar's Projects list follows at once.

**A tree chooses a model per agent** (`models` on the tree, agent slug → model id; `TreeModelsService`, rules in
`models/lib/tree-models.ts`). The tree's Settings page lists each agent in its type's work that asks a model (walked from the grove
agent's procedure, `modelAgentsOf`), with what it would use on its own; a choice there is for that tree only, and is
read when each of the tree's runs starts: the grove agent's by the launcher (`modelFor`), every run under it by
`EngineResolveAgentActivity` from the run's root id (`treeOfGroveRun`), so in a tree's run an agent gets the tree's choice
or its own model, never one handed down from the run above it (the judge stays on its own while the executor is moved).
An agent on one of the person's machines can be chosen too, for an agent whose procedure branches at Where It Runs; an agent whose "Runs on" is a machine keeps it. A chosen model that is gone shows on
the panel and fails the agent's runs with its name. Koala reads the models in `read_tree` and `run_tree` and proposes a
change with `propose_tree_model` (card `set_tree_model`); `mechanics-tree-model` proves it (expectation `treeModels`).
A `choose-model` trace keeps the model's name in its summary, so a story's run shows the model each round ran on.

**Every workflow says whose it is.** Each start carries the `KoalaOwner` search attribute (`startedFor(owner)` in
`platform/lib/workflow-owner.ts`; `platform` for platform work). The shared client (`platform/lib/temporal-client.ts`) registers the
attribute on connect, refuses a start without it (`UnownedWorkflowError`), and stamps a check space's workflows as its
person's. Child workflows inherit their parent's owner. The Temporal page lists, counts, opens and cancels only the
viewer's own; an admin can switch to everything, and an instance's owner sees everything on it. Workflow tests create
their server with `workflows/temporal-test-env.ts`, which registers the attribute.

**Large payloads are stored outside Temporal.** Every Temporal client and worker builds its
converter with `buildDataConverter(key, sharedPayloadBlobs())`: payloads are compressed, then
encrypted, and any still over 128 KB go to Mongo `temporal_payload_chunks`, leaving a claim in the
history (`platform/lib/payload-storage.ts`, Temporal's `externalStorage`). A new process that talks to
Temporal must use it too, or it cannot read an offloaded payload. A daily sweep releases a
workflow's payloads once Temporal no longer has it. `npm run test:big-run-live` proves it on a real
research run.

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

These are enforced, not aspirational: `npm run lint` is green and fails on a new violation (the frontend's rules, and
the backend's rules in `apps/backend/eslint.config.js`: no unused import, variable or parameter, the layer rule — `lib`
imports nothing above it, a service never imports a route or the wiring, a route never imports the wiring — and
`boundaries/areas`, an area imported only through its `index.ts`), the frontend is `strict`, and CI (`.github/workflows/ci.yml`)
runs typecheck + lint + both unit suites on every push. Each rule below is here because something in this repo broke without it.

### Frontend

- **The frontend is laid out by area** (`src/features/<area>/`, the list in Repo structure), and **an area imports
  another only through its `index.ts`**, never a file inside it. `shared/` and `platform` import no feature, and no
  feature imports `shell/`. The `boundaries/areas` rule in `apps/frontend/eslint.config.js` enforces all three; tests
  are exempt, since they mock and spy on the modules they replace by path. An `index.ts` lists only what other areas
  use, one `export … from` per module, and it is the one kebab-case file that re-exports components.
- **PascalCase = exports a component; kebab-case = exports none.** `projects/lib/leaf-types.ts` and
  `home-summary.ts` already follow this; `react-refresh/only-export-components` is its linter.
- **Nothing at `src/` root** except `App.tsx`, `main.tsx`, `index.css`, and `api/client.ts` beside them.
- **A folder of more than ~4 files gets a `shared.ts`** that its files import instead of each other: an area has one
  at its root, and a large screen folder inside it (`projects/components/Workspace/`, `engine/components/Studio/`) its own.
- **If it came from HTTP it belongs to react-query.** No hand-rolled loading/error state.
  `CloudAccounts.tsx` (21 `useState`, 9 raw `fetch`) is the counter-example.
- **UI state lives in the component that renders it**, and **never pass a raw `setState` down** —
  pass a named intent. `ClustersView` receiving `setExpandedCluster` from a 2,858-line parent that
  never reads it is the anti-pattern.
- **Client state that crosses components lives in a zustand slice** in its area's `stores/`, one per
  domain — `platform/stores/shell.ts` (view, user, notifications), `platform/stores/socket.ts`, `engine/stores/live-turns.ts`.
  Never one store for everything: that is structurally what App.tsx once was. Subscribe with a selector per value
  (`useShellStore((s) => s.view)`), so an unrelated change does not re-render you.
- **Server state is react-query's, never a store.** Putting fetched records in zustand means
  hand-writing caching, dedup, invalidate-after-mutate and refetch.
- **Context is for what a store cannot do** — a value scoped to a subtree rather than the app.
  `WorkSourceContext` (`projects/lib/work-source.ts`: the instance's board or the hub's) earns it.
- **No component contains a URL.** Components import hooks; hooks call their area's `api`; only those
  modules import `api/client.ts`.
- **`props: any` is banned.** Let the compiler enumerate the interface — `NginxView.tsx`'s docblock
  describes the method.
- **Domain shapes are declared once**, in their area's `types` or from `@koala/harness-types`. Deliberate
  duplication across the wire carries a `── DUPLICATED, KNOWINGLY ──` block naming the backend file
  that wins; see `projects/types/grove.ts`.
- **Two copies of a `useEffect` means extract a hook.** Logic that needs no React goes to the area's `lib/` as
  pure functions with unit tests — `home-summary.ts` (21 tests) is the strongest pattern here, and
  `engine/lib/chat-composer.ts` is what came out of `ChatSurface` beside its hooks `useChatComposer` and `useChatCards`.
- **Tests are colocated** (`Foo.tsx` → `Foo.test.tsx`) and test the extracted unit, not `App`; the tests that drive
  the whole app sit with the shell.

### Backend

- **The backend is laid out by area** (`src/<area>/`, the list in Repo structure), and **inside every area the arrow is
  one-way: `wiring/ → routes/ → services/ → lib/`**, with `platform/middleware/` feeding routes.
  `lib/` is pure and imports nothing above it — in its own area or any other; `engine-host/` and `extensions/` sit
  between services and `lib`, so `lib` never imports them either (the `Task` helpers are `projects/lib/tasks.ts`, the
  workflow ids `platform/lib/workflow-ids.ts`). `wiring/` holds what constructs services from the database and env.
  Each area's records are its own `store.ts`, and `platform/lib/db-interface.ts` only composes them.
  `projects/lib/leaves.ts` (38 pure functions, no I/O) is the target shape. The backend lint enforces the arrow.
- **An area imports another only through its `index.ts`** (`src/<area>/index.ts`), which re-exports exactly what other
  areas use: one `export … from` per module and kind, values apart from `export type`, in path order. A cross-area
  import that is only types is `import type`, since under `verbatimModuleSyntax` `import { type X }` still loads the
  module. Past an index go only: **values from another area's `lib/`**, taken directly by a pure file (a `lib/`, a
  `store.ts`, a workflow) and by `engine-host/`, `extensions/` and `eval/`, because an index loads its whole area,
  services included, and a workflow's bundle may hold only pure code (a pure file takes only types from an index);
  **an area's `wiring/`**, which the root (`src/index.ts`, `worker-*.ts`) composes directly, since a wiring builds on
  areas that build on its own; **`platform/lib/mongo-db.ts`** composing every `store.ts`; and the eight imports in
  `DIRECT_TO_STAY_ACYCLIC` (`apps/backend/eslint.config.js`), each of which would close a loop through an index (hub's
  wiring and engine's routes, projects' channel and engine's conversations, …). The `boundaries/areas` rule there
  enforces all of it; tests are exempt and mock by path. **The backend has no value-import cycle**, and a direct
  import is how one comes back: a cycle fails only at runtime (`Cannot access X before initialization`), which tsc
  cannot see, so check with `npx dpdm -T --no-tree --no-warning --transform 'src/**/*.ts'` in `apps/backend` (the one
  it lists, `pack-sampling` ↔ `tunables`, is inside `agent-engine`).
- **The packages, and what may import what.** Apps import packages; no package imports an app. `@koala/harness-types`
  is types only (interfaces and type aliases, no dependencies): the shapes the backend, the frontend, `agent-engine` and
  `context-engine` share. `@koala/engine-core` is what every process that runs tools shares: the tool and environment
  contracts (`./contracts`), tool execution, scopes, fingerprints, the external-agent shapes, `heartbeatWhileRunning`,
  and the payload codec (`./payloads`, `buildDataConverter`); it depends only on `@temporalio/common`, uses Node's
  `crypto`, `path` and `zlib`, and is imported by the backend, the machine agent (`apps/local-agent`) and
  `agent-engine`. `@koala/context-engine` is what fits in a model's context (compaction settings, token budgets,
  observation masking, the state vector); it depends on `harness-types` and is imported by `agent-engine`, the machine
  agent, and once by the backend (`memory/lib/memory-store.ts`). `@koala/agent-engine` is procedures, their nodes,
  agents, the model layer (`patientFetch`, the rate limiter) and the procedure builder, over `engine-core`,
  `context-engine` and `harness-types`; its root export uses Node, so a workflow takes values only from its
  `./workflow` and `./procedure` subpaths and only types from its root and from `engine-core`; the frontend imports
  `./procedure` and `./procedure-builder`. `cdktf-infra` is imported by nothing: `InfrastructureService` runs it as a
  CDKTF app from `packages/cdktf-infra`, the stack picked by `STACK_TYPE`. **A new shared type** goes to
  `harness-types` when it is a shape with no code that crosses the wire to the frontend, to `engine-core` when the
  backend's workers and the machine agent both run with it, and otherwise stays in its area's `lib/`, the frontend
  duplicating it knowingly (`── DUPLICATED, KNOWINGLY ──`, naming the backend file that wins).
- **A route handler does four things**: read the request, authorize, call one service method, shape
  the response. A loop, a prompt or arithmetic belongs in a service or `lib/`.
- **No `db.*` in a route.**
- **Something becomes a service** when it holds state beyond a request, owns a resource, or is the
  only writer of a collection. Otherwise it is a `lib/` function. `VpsCatalogService` over
  `infrastructure/lib/vps-catalog/` is the model.
- **One router per URL prefix in `src/<area>/routes/<domain>.ts`, exported as a factory** taking its deps,
  so `src/platform/routes/test-harness.ts` can mount it without booting the app.
- **A test may not re-declare the logic it tests.** Two security tests did, and could not fail —
  see `platform/lib/ownership.ts` and `accounts/lib/oauth-gate.ts`.
- **Route order in `bootstrap()` is load-bearing**: the Gitea webhook must stay before
  `express.json()` (it verifies an HMAC over the raw body), `app.use('/api', requireAuth)` before
  every `/api` router, and the SPA catch-all last.
- **Every async handler is wrapped in `asyncRoute`.** Express 4 does not await handlers, so a
  rejected promise produces an unhandled rejection and NO response — the request hangs until the
  client times out. This has bitten every extraction: a missing import in the trees router
  presented as a 15-second hang with nothing to diagnose, and became a 24ms error once wrapped.
- **Typecheck is necessary and not sufficient.** Three failures during the router extraction
  compiled clean and broke at runtime: a duplicate import only vitest's transform rejected, a symbol
  used without being imported, and one imported from the wrong module — the last took the dev server
  down on reload while `npm run typecheck` reported zero errors. Run the suite, and hit the route.

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
2. **Unit** (`npm run test:unit`) — typecheck + Vitest, frontend + backend. ~80s (20s typecheck, 29s frontend, 29s backend). The `<5s` this used to claim has not been true for a long time.
3. **Worker isolation** (`npm run test:worker`, `tests/worker-isolated.ts` via `npx tsx`) — runs real Temporal workflows (`ClusterProvisionWorkflow`, `AppDeployWorkflow`, etc.) end-to-end (k3d, CDKTF, Helm, kubectl) without a browser or webserver.
4. **Full E2E** (`npm run test:e2e`) — Playwright driving the React UI; starts host and cluster workers on the host network to support all deployment types.
5. **Remote-host integration** (`npm run test:remote-integration`, `tests/remote-host-integration.ts`) — boots a real disposable QEMU/KVM VM (`tests/lib/disposable-vm.ts`) and drives the actual `POST /api/clusters` (`provider: 'remote'`) → Temporal → SSH-bootstrap-k3s path against it, the same way a user adding their own GPU workstation or a Phase-3 VPS would. Slow (~10-15 min, includes a one-time ~600MB cloud image download cached in `tests/.vm-cache/`) — not in the default `npm test` chain, only `npm run test:all`.

## Playwright / k3d gotchas

- **`workers: 1` only** — E2E tests provision/deprovision real k3d clusters bound to host network ports; parallel workers collide on ports.
- **Worker restarts on failure**: a failed test restarts the Playwright worker process, which reloads the spec file and generates a *new* random `CLUSTER_NAME` (e.g. `e2e-fleet-XXX`) — but already-passed tests aren't rerun. A cascade of timeouts after one failure almost always means the *first* failure is the real bug; look there, not at the timeouts.
- **Stale k3d containers**: leftover containers from a previous run (e.g. `k3d-isolated-fleet-XXX-server-0`) can make `k3d cluster create/delete` fail. `npm run clean-dev` removes leftover k3d containers/volumes.

## Files: code in git, everything else on the person's MinIO

Plan: `~/.claude/plans/file-uploads.md`. **Where you drop decides.** A project's Files page shows two roots:
- **Repository**: code dropped there, or on a folder in it, is committed in one commit as the person (`POST /api/projects/:id/files/drop`,
  body typed `application/vnd.koala.drop+json` so the 20 MB JSON parser leaves it alone, `RepositoryDropService` →
  `GiteaService.commitDrop`, bytes intact). A project whose files live on the person's machine gets them written there byte for
  byte (`sandbox:writeFile` with `encoding: 'base64'`).
- **Files**: everything else, on the person's own **MinIO** (owner, 2026-10-21: MinIO only; Nextcloud stays a deployable app,
  not a file server). `FileService`, `FileStores`, `files/lib/file-places.ts`, `/api/files/...`: the project's MinIO and its folder
  (`files` on the project, a folder named once from the project and kept), else the person's default (Settings → Files,
  `fileSettings`), else none. Files live in the bucket `koala-files` under the folder; an empty folder is a `.keep` the listing
  hides. Uploads and downloads stream (`X-File-Type` carries the type; the body is always octet-stream so nothing parses it); no
  size limit. With no server, a drop waits on the page and Files offers **Start MinIO for this project** (one click, on the
  project's cluster, `koala-files[-n]`); it goes through once the server runs.
- **Koala's own file browser** (`features/files/components/StoredFiles.tsx`, rules in `files/lib/file-browser.ts`): upload, new folder, search by
  name across the project (`/search`), sort by name, size or date, select several to move or remove, drag a file or the selection
  onto a folder, rename, and open a file to preview it (images, PDF, video, audio, text; `StoredFilePreview`, in the Files page's
  right pane, a dialog elsewhere). A person's own files (chat attachments outside projects) and their links are under Settings → Files.
- **Share links**: a file shared for a day, a week or a month (`fileShares`, `files/lib/file-shares.ts`) is served by Koala at
  `/api/share/<token>` with no session (`/share/` in the guard's public prefixes), streamed from MinIO, so MinIO is never exposed.
  Revoked from Settings → Files; expired ones are removed when opened; a project's go with it. Every person's file is served with
  `nosniff`, and anything that could run script (HTML, SVG, XML, JS) under a sandboxing CSP (`files/lib/file-serving.ts`).
- **A story's page** takes both: **Code for this story** goes to the story's checkout (`StoryDropService`, recorded as `drops` on
  the story): committed on its own branch `drop/<story>/<id>` from `main`, merged into the story's worktree at once when it
  exists (`applyDrop`, `git merge --autostash`, so the worker's uncommitted changes stay), otherwise brought into the tree's
  repository (`keepBranch`) or left in Gitea for the next workspace start, and merged when the checkout is made
  (`mergeDrops` in Prepare Worktrees). A conflict changes nothing and names the files. **Files for this story** go under
  `stories/<story>/` on the project's MinIO. `mechanics-story-drop` proves both code paths on a script.
- **Chat attachments** (paperclip, drop or paste in any composer) are uploaded first, to the chat's project
  (`attachments/<day>/<time>-<name>`) or the person's own files (`chats/<day>/...`), then sent with the message
  (`attachments` on the person's message, `engine/lib/attachments.ts`); the model is told where each is and how to read it, in that turn
  and every later one (`heardAs`). A channel post can be only attachments.
- **Agents' tools** (extension `files`): `list_files`, `read_stored_file` (text whole up to 100,000 characters, a binary file
  described), `store_file`, `remove_stored_file` (both destructive, so they ask), on the project named or the run's or chat's
  own, else the person's files. Koala holds all four; the executor and research the first three.
- Deleting a project deletes its files (`RemoveProjectFilesActivity`, behind the `project-files` patch; listed in the popup).

## Data

Default persistence is MongoDB (`apps/backend/src/platform/lib/mongo-db.ts` connects and composes one store per area, `src/<area>/store.ts`, split on 2026-10-22), managed via `docker-compose.mongo.yml` / `scripts/ensure-mongo.sh`. Unit tests run on a real Mongo in memory (`testDatabase()` in `platform/lib/test-database.ts`; the in-memory fake `MemoryDB` was deleted on 2026-10-22, so the suite proves the database and not a copy of it). A deployment's passwords, keys and tokens (`DEPLOYMENT_SECRET_FIELDS` in `infrastructure/lib/deployment-secrets.ts`) are
sealed with `DATA_KEY` at the store boundary (`MongoInfrastructureStore` seals on save and unseals on read, so every reader sees plain
values), and the startup migration `deployment-secrets-sealed` seals records stored plain before.

`apps/backend/data/` still holds `logs/` (per-resource provisioning/deployment logs, tailed over
socket.io — see `InfrastructureService`'s `LOG_DIR`) and `nginx/` (proxy config). The `*.json` files
in there are unused leftovers, **not** the source of truth.

## Prerequisites

- Docker, k3d, kubectl, helm (or use pre-downloaded binaries in `bin/`)
- Node.js 20+
- Temporal workflows need the Docker container on port 7233 (`docker-compose.temporal.yml`)
- GPU workloads (vLLM) need the NVIDIA/AMD driver and container toolkit on the host — see `scripts/setup-gpu.sh`
