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
npm run clean-dev    # kill all dev processes, delete k3d clusters, clean DBs (scripts/cleanup-all.sh)

npm run test         # test:unit → test:e2e:sync (alive check → unit → tests/e2e.spec.ts via Playwright)
npm run test:all     # test → test:infra:integration → test:remote-integration → test:unit:vpn
npm run test:unit    # typecheck + test:unit:frontend + test:unit:backend (Vitest, ~80s total)
npm run test:alive   # scripts/alive.sh — Docker/k3d/K8s API/Temporal/worker pod health, fails fast with fix hints
npm run test:worker  # tsx tests/worker-isolated.ts — runs real Temporal workflows without browser/webserver
npm run test:e2e     # test:alive → Playwright (skips the unit preflight `npm test` does)
npm run test:infra:integration    # full cluster provision → verify → destroy, ~5 min (tests/infra-integration.ts)
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
npm run test:instance-live        # k3d cluster + root container + charts/instance → sign in through root → sandboxed run, ~10 min, cleans up
npm run test:remote-integration   # boots a disposable QEMU VM, provisions it as a provider:'remote' cluster over
                                   # real SSH, verifies kubectl + deploys a real app, tears down VM+cluster — proves
                                   # the distributed-systems plan's Phase 2 (SSH k3s bootstrap) end-to-end, ~10-15 min.
                                   # Needs qemu-kvm/cloud-utils/genisoimage + /dev/kvm (tests/remote-host-integration.ts)
```

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
`tsx`, which is why `update.sh` restarts through the unit.

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
| `apps/backend/src/index.ts` | Express server entry — `bootstrap()` inits DB, all services, socket.io, and mounts the routers. 1,289 lines. Five routes are still inline and each has a reason: the Gitea webhook (must precede `express.json()` — it verifies an HMAC over the raw body), `/ingress/verify` (unauthenticated by design), and three `/api/harness` config routes |
| `apps/backend/src/lib/db-interface.ts` | `Database` interface + `createDatabase()` — MongoDB unless `NODE_ENV=test` and not E2E, in which case `MemoryDB` |
| `apps/backend/src/lib/mongo-db.ts` / `memory-db.ts` | MongoDB native driver impl / in-memory mock for unit tests |
| `apps/backend/src/lib/auth.ts`, `crypto.ts` | JWT sign/verify, password hashing; AES-256-GCM encrypt/decrypt/mask for stored secrets |
| `apps/backend/src/lib/credential-resolver.ts` | Resolution chain for cloud creds: user-stored → `process.env` → mock mode |
| `apps/backend/src/routes/` | 33 routers, one per URL prefix, each a factory taking its deps. `routes/harness/` composes six sub-resource routers under `/api/harness`. `routes/test-harness.ts` mounts one router on a bare app so a route can be tested without booting `bootstrap()` |
| `apps/backend/src/middleware/` | `asyncRoute` + the error responder, and `auth.ts`'s `createAuth()` — `requireAuth`, `requireAdmin`, the session cookie and the invite gate. Express 4 does not await handlers — an unwrapped async handler that rejects sends NO response and the request hangs |
| `apps/backend/src/services/` | Service layer (see below) |
| `apps/backend/src/workflows/` + `activities/` | Temporal.io workflow/activity definitions |
| `apps/backend/src/worker-host.ts` | Host-side Temporal worker — cluster provisioning/destruction activities |
| `apps/backend/src/worker-cluster.ts` | In-cluster Temporal worker — app deploy/destroy/resize activities; reads K8s service account when in-cluster |
| `apps/frontend/src/main.tsx` / `App.tsx` | React entry / the shell: routing, auth, the socket wiring and the view switch. 505 lines |
| `apps/frontend/src/api/` | The one axios client (`client.ts`) and one module per domain. **No component contains a URL.** |
| `apps/frontend/src/stores/` | zustand slices for client state — `shell.ts` (view, user, notifications), `socket.ts`. Server state is react-query's, never a store |
| `apps/frontend/src/types/` | Domain shapes. Where one mirrors a backend record it carries a `── DUPLICATED, KNOWINGLY ──` block naming the authority |
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

All `/api/*` routes require a session (JWT in a `session` cookie) via `requireAuth` from `middleware/auth.ts`'s `createAuth()`, mounted in `bootstrap()`, except `/auth/login`, `/auth/register`, `/auth/2fa/verify`, and the GitHub/Google OAuth routes. When `IS_E2E=true`, `requireAuth` short-circuits to a mock user so Playwright doesn't need to log in. GitHub/Google OAuth fall back to a zero-setup local mock flow when their client env vars are blank; 2FA SMS falls back to a logged warning when Twilio env vars are blank.

The public-path allow-list lives in `middleware/auth.ts`, **not** in `routes/auth.ts` — a router
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

Removal, project deletion and tree deletion stop workflows by **cancelling** them (`lib/stop-workflow.ts`), never by
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

`ACCOUNT_DATA` in `lib/account-removal.ts` classifies every Mongo collection as removed by owner, by id, through
what it relates to, or shared; a test fails when a collection in `mongo-db.ts` is missing from it, so **a new
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
served; `lib/machine-payloads.ts`), holds it in memory only, and starts its device worker with the same converter as
every platform worker (`buildDataConverter` in `@koala/engine-core/payloads`, one codec shared by the backend and the
machine). Payloads over 128 KB go through the backend over that socket (`payloads:put`/`payloads:get`, `remote-blobs.ts`),
since a machine never reaches Mongo. A new keyring restarts the worker (`DeviceWorkerHost`). Without this nothing sent to
`device-<id>` could be read; `machine-live` and `mesh-live` now run a two-turn chat on the machine to prove it.

**Picking an agent on a machine.** Every model picker except the account default and Checks has a "My machines" section:
one row per ready agent per machine, `machine:<deviceId>:<agent>` (`machine-choice.ts`). A run picked that way runs the
`external-agent-chat` procedure (chat) or `external-agent-task`, on that machine (`machineRunFor`, refused with
`MACHINE_UNAVAILABLE` when the machine is gone, offline or its agent is not ready). An agent whose "Runs on" (Studio) is a
machine always runs there; a machine picked for one run is never inherited by the runs it starts. A conversation keeps one
session per machine, agent and model (`machineSessions`), so the next turn resumes it; a failed turn is saved with its reason.

**An agent on a machine gets its persona's tools, and runs on the model picked.** The external-agent procedures resolve the
persona's tools (Resolve Tools) and hand them to the `external-agent` step, which serves every one not bound to an
environment (the agent has its own shell and files) through the machine's local MCP server, named `koala`, and tells the
agent to call them there. A call the agent makes is held on the machine and handed back to the run (`state: 'calls'`):
`runExternal` runs it the way a model's call runs (`runOne`: the turn log, cards, hand-offs), asking the person first when
the tool is destructive, then answers the machine (`op: 'result'`); a cancelled run answers held calls as cancelled. Discovery
opens a session (no prompt) to read each agent's `model` config option (ACP `configOptions`), reported as `models` with
`agents:found`; the picker offers one row per model (`machine:<device>:<agent>:<model>`), a run sets it with
`setSessionConfigOption` before its first prompt (a model the agent no longer offers is refused), and the model it ran on
comes back on the step (`model`), in the trace summary and so on the run's rounds.

## Roles: root, instance, combined

`ROLE` (read by `lib/platform-role.ts`) decides what a backend is:
- **`combined`** (the default, and every dev box) is everything at once, as before;
- **`root`** holds accounts and the Ed25519 signing key (`ROOT_IDENTITY_KEY`), and mounts no tenant
  route — every tenant router is mounted on `tenant` in `bootstrap()`, which is the app except on root;
- **`instance`** serves one owner (`INSTANCE_ID`, `INSTANCE_OWNER_ID`, `ROOT_URL`, `ROOT_PUBLIC_KEYS`),
  has no account routes, and signs people in only through root.

Sign-in on an instance: the instance sends you to root's `/api/identity/go`, which issues a 60-second,
single-use token for your instance and redirects to `<instance>/#/handoff?token=…`. The instance
checks the signature, audience, expiry and owner, records the token id so it cannot be reused, and
sets its own session. Register an instance with `npm run instances -w apps/backend -- add <id> <owner> <url>`.

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
stored agent's old tool list onto grants (`lib/tool-grant-migration.ts`, in `seedAll`) and drops a copy of a built-in
that differed only in its tools.

**MCP servers are a catalogue of their own** (`mcpServers`, `lib/mcp-servers.ts`, Studio → MCP Servers, `/api/mcp/catalogue`).
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
known ones not added; `propose_mcp_server` (rules in `lib/mcp-proposals.ts`) puts an `add_mcp_server` action card in
the chat — add a known one (with the person's notes, depends-on, offer/omit), add a new one, or give one they have to
agents. Applying it (`ActionService`) adds and captures the server, then gives it to each agent named through
`setServers`, which rebuilds a workspace server's holders' images. `mechanics-proposed-server` proves it (check stage
`applyAction`, expectation `mcpServer`).

**When a run asks before a call** (the `approve-tool-calls` step, `ports.approve` in `AgentRunWorkflow`): on someone's
own machine every call asks; elsewhere a destructive tool asks (an MCP tool is destructive unless its server says
otherwise). A call to a tool that runs inside the run's sandbox (`binding: 'environment'` while the environment is a
sandbox) never asks, whatever it does (behind the `sandbox-calls-unasked` patch). **Auto mode** turns asking off for a
whole run: a person switches it on per agent (Studio, the agent's settings; `autoModeSettings`, so a built-in stays
built in) or per tree (the tree's Settings page; `autoMode` on the tree), and a run goes unasked when its agent is on, or
the tree it works on — its sandbox's `tree-<id>` workspace or its chat's tree — is (`AutoModeService.unasked`, read at
each ask through `EngineAutoModeActivity`, behind the `auto-mode` patch). The approval box answers the call its notice
names (`callId`) and says what was decided.

## Memory

Memories are made by the `memory-keeper` agent, never by a hidden model call. It is driven by events,
not polling. `AgentRunWorkflow` reports `turn-started` and `run-ended` to the backend
(`EngineConcludeActivity`), and `MemoryKeeperService` (rules in `lib/conclusions.ts`) hands the
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
compare results on the same model (`sameModel` in `lib/bench.ts`). The Memories page and the agent's practices show
and filter by model; `mechanics-memory-per-model` proves recall on a script (a scripted space's model is `scripted`).

**A tool note is advice shown beside a tool** (`category: 'tool_note'`, with `tool` — a built-in's name, or a server's
tool with `server` — or `server` alone for all of a server's tools; `lib/tool-notes.ts`). The keeper proposes one with
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
  **script** (`scenario.script`, `lib/check-script.ts`): rules matched on what a model sees (`offered`, `called`,
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
- **Turn checks** (`turn: true`, `lib/turn-check.ts`) are one model turn of an agent: its tools offered, nothing run
  (procedure `turn-check`). `chooses` names the tool it should pick (or `null` to answer without one) and checks its
  arguments, read from the model call's trace. They replaced Level 1; the built-in ones are `eval/level2/turns.ts`.
- **Any check can repeat** (`repeats`, `passAt`, `lib/check-attempts.ts`): a turn check's attempts share one space, any
  other gets a fresh space per attempt; the result keeps every attempt, and a space that leaks fails the check whatever
  `passAt` allows. Coverage (`lib/check-coverage.ts`) and comparing two runs (`lib/check-compare.ts`) count every attempt.
- The space's runs are handed to the person before it goes, so every result still opens in the run view.
- **The Studio** (Agents, Tools, Procedures, Tree Types) is one explorer per concept (`components/Studio/Explorer.tsx`):
  items grouped by how they are used (agents: `lib/agent-usage.ts` on the backend), each item's parts opening on the
  right like files. Built-in procedures open read-only; "Make my own copy to edit" saves a copy under the same id.
- **Checks live on what they check** (Studio, `~/.claude/plans/studio-layout.md`): there is no all-checks page. A
  check shows on every agent, tool and procedure page it touches, worked out by `lib/check-subjects.ts` from its
  agent, hand-offs, procedure (a step check's `step.from`), and the tools it expects or calls. One shared list
  (`components/Checks/CheckList.tsx`) takes the scope; "New check" starts as a check of that page's subject.

## The bench

Level 2 scenarios also run on their own, when the model is idle (`BenchService`, `lib/bench.ts`).
Top-level runs report start and end; `BenchIdleWorkflow` counts the owner's idle minutes down from
the last event. When the time is up, everything runs if the last full run is older than the setting,
otherwise only the scenarios of agents whose fingerprint changed. A scenario that passed last time and
fails now is a regression: it is recorded on the run, shown as a toast, and marked in that check's history. Settings
live on Settings → The bench.

## What runs (the Running page)

Sidebar → **Running** (`components/Running/`, a count badge while anything runs) lists the person's running work in
plain words, from Temporal (their `KoalaOwner` workflows, top-level only; the conversation countdowns and the bench's
idle timer are left out) mapped by `lib/running.ts`: the bench and checks (progress from the check run), the memory
keeper (what it reads, from the run's memo `about`), tree runs, releases (and whether one waits on the card), chat turns
(the memo's `agent` and `conversation`, written by the run starter), workspace builds, deletions and deploys; an unknown
type is listed by its type. Each opens where it lives and is cancelled its own way (`RunningService`: a check run's
`cancelCheck`, a tree's `stopRun`, a run's `cancelRun`, otherwise a Temporal cancel); what cannot stop part way
(deletions, an approved plan, saving a workspace) says why. Two switches pause **the bench** (its own `enabled`) and **the
memory keeper** (`keeperSettings`): a paused keeper holds each conclusion in `deferredConclusions`, in order, and hands
them all over when resumed (`MemoryKeeperService.setPaused`). API: `GET /api/running`, `POST /api/running/:id/cancel`,
`PUT /api/running/bench|keeper`.

## Platform keys

Four keys, one per purpose, loaded once by `lib/keys.ts`'s `loadKeys(process.env)`:
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
(`lib/activity-liveness.ts`): the 30-day `startToCloseTimeout` Temporal requires, and a one-minute `heartbeatTimeout`.
Every worker (host, cluster, engine, stream, a machine's device worker) heartbeats every activity while it runs
(`heartbeatWhileRunning` in `@koala/engine-core`), so a dead worker is noticed in a minute and the activity runs again
elsewhere, while a slow one is never cut off. Helm and `kubectl --wait` take `CLI_CEILING` (720h) for the same reason.
No wait inside an activity watches a clock: it ends on the thing it waits for, on a state that will never recover
(`assessWorkload` in `lib/workload-health.ts` — `ImagePullBackOff`, `CrashLoopBackOff` and the like), or on a stop. The
pieces that used to cut work off and no longer do:
- **Model calls** go out through `patientFetch` (`agent-engine/src/model/patient-fetch.ts`): Node's `fetch` with an
  undici `Agent` that has no header or body timeout, so a long prefill or a slow stream is never dropped at 300 s. The
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
- **Builds and releases.** Workspace image builds, Odoo release jobs and rollouts, browser tests, pipeline builds and
  cluster provisioning wait for their work however long it takes.
`mechanics-long-command` proves a command outliving any old limit.

**Odoo browser tests.** `odoo-e2e --keep` leaves the throwaway Odoo served between runs (reused while `addons/` is
unchanged, upgraded in place when it changed, `--stop` ends it). Specs use `e2e/odoo.ts` (`lib/odoo-e2e-helpers.ts`:
`signIn`, `openAction`, `fill`, `choose`, `addLine`, `save`, `press`, `smartButton`, `reportHtml`), whose `test` gives each
step ten seconds and attaches `page-at-failure`, an outline of the page, which `odoo-e2e` prints and `readE2EReport`
keeps as `E2ETest.page` (task checks and the release card show it). The image carries the helpers and `odoo-e2e` copies
them into a repository that lacks them.

**Workspace images can be product images.** A tree works in the image its type's `language` names. The engine's
image planner takes the host's bases (`extensions/workspace-bases.ts`: the UBI ones plus `extensions/odoo/`'s Odoo 18 and 20, each
with PostgreSQL 18 and `odoo-check`); a base may carry setup steps, and a `dnf` install falls back to `apt-get`
(`APT_NAMES` maps the names that differ). Workflow code must not import `workspace-bases.ts` — the engine's root export
pulls in `crypto` and `path`, which Temporal's workflow bundle refuses.

**A tree type can have versions** (`versions` on the type: what they are versions of, each choice's version and the
workspace it works in, and the default; `lib/tree-types.ts`). The Odoo type offers Odoo 20 (`odoo-20`, the default)
and 18 (`odoo`). A tree records its `version` when it is made (`versionForNewTree`: the plan's `tree.version`, the New
Tree dialog's choice, or the default; one the type does not offer is refused), and it never changes. The tree works in
that version's workspace (`treeLanguage`, through `treeLanguageFrom`), its starter is rendered with `{{version}}`
(`FROM odoo:{{version}}`, manifest versions), and the planner reads the versions in `list_tree_types` and
`describe_tree_type`. A tree from before versions works in the type's own `language`; startup stamps it with that
version (`stampTreeVersions` in `seedAll`). The Studio keeps a type's versions when it is saved but cannot edit them.

**A tree's workspace is composed, built and published.** Plan: `~/.claude/plans/workspace-tool-servers.md` (step 0).
- A project says what its workspace needs in `.koala/workspace.json` on `main` (`lib/workspace-file.ts`: packages by
  manager, an install script, languages, plain env values — a secret-looking name is refused).
- One composer (`lib/workspace-composition.ts` → the engine's `planImage`) puts the tree type's base, that file and the
  tools of every agent that works in the tree into one plan, each line saying where it came from (`PlanLine.from`).
- The image a tree works in is its **published workspace** (`publishedWorkspaces`, `lib/published-workspace.ts`): the
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
project may override it (`releaseHowOf` in `lib/release-run.ts`: the project's setting, then its type's, then a chart in
the repo means `slots`, otherwise `replace`). The `releases` extension (`extensions/releases/`) holds the steps and three
procedures, run by agents with no model:
- **`slots`** (agent `release`, the Odoo type's): the first build goes into slot `a` (the init job creates `odoo_a` before
  slot a's Odoo exists — an Odoo started with `--database X` initialises X itself, so a slot's Deployment must never exist
  while its database is prepared); each later build is prepared in the idle slot from a copy of the live database and
  filestore, quieted, upgraded (`-i` new modules, `-u` the rest), **compared with live** (Compare With Live,
  `releases.compare`), its browser tests run, and it waits on Wait for Person (`decide`: Cut over / Discard / Run tests
  again), answered by the release card (`/api/projects/:id/releases`). The comparison (`lib/release-compare.ts`, kept as
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
- **`slots-roll-back`** (agent `release-roll-back`): offered on the live release until a later build reuses that slot,
  it starts the kept slot, waits for it, then switches `live` to it — the app returns to the snapshot taken at the
  cutover, so anything entered since is lost, and the confirm says so.
- **`replace`** (agent `release-replace`): an image project's build deployed in place of the running app through the
  same deploy the backend uses (`services/AppDeploy.ts`); the backend's reconcile loop follows a deployment whichever
  side started it.

`OdooReleaseService` starts one release run per build (`release-<projectId>~<stamp>`, bound to the project), one at a
time per project: a build arriving while a preview waits stops that run, whose cleanup (Settle Stopped) clears and sets
the preview aside; one arriving while a release is prepared waits as `queued`, and the newest queued build goes next.
The steps write the release records; the service follows them and the run, and tells the person. The cluster is the
truth for which slot is live (`helm get values`); releases are records (`odooReleases`). Each project's release has
a deployment record (`appType: odoo-project`, with its `namespace`), so it shows among apps, goes with the project, and destroying it
uninstalls the release and its namespace. A release is named once, at its project's first release: the project's name plus a
short hash of its id (`newReleaseName`), stored as `releaseName` — so two projects with the same name never share a
namespace or a host, and renaming a project does not orphan its app; a project released before names were stored keeps
the name it has. Its namespace is labelled `koala.dev/owner` and `koala.dev/project` before Helm installs into it. Releases reach clusters the way `ClusterService` does
(`activities/cluster-access.ts`'s `reachCluster`). Exposing the app also exposes its preview on its own address, and
the project's builds panel shows the releases with a card to cut over or discard a waiting one. `npm run test:odoo-release-live` proves it on the system cluster with
a throwaway project, ~4 min, and removes everything.

**A new tree that produces a service gets its own project** (`TreeHomeService`, rule in `lib/tree-home.ts`): plan
approval (`homeTree` in plan adoption) and `POST /api/trees` both call it, so it does not matter whether the tree came
from chat, a check or the New Tree dialog. The project (`project-<treeId>`, so a retry finishes rather than doubles it)
gets a repository, the build webhook, the person's own cluster and auto-deploy (`ProjectRepoService.createProject`, the
one way a project gets a repository). The New Tree path also seeds the type's starter; adoption writes the starter with
the plan in one commit. A tree that produces an artefact gets no project. A build is pinned to the commit that was pushed
(`lib/build-plan.ts`), and a push whose commit has no Dockerfile records no build at all.

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
(`releaseSkipped`, `lib/release-paths.ts`). A check's world can lay settings over a tree type (`world.treeTypes`).

**Every project has a channel, and the channel hears what happens to its work.** A project's channel is its own
conversation (`channel-<projectId>`, `kind: 'channel'`, `ProjectChannelService.ensure`, made with the project or the
first time its page opens, bound to its tree, deleted with it).

**A project opens on its board** (`components/Projects/Board/`, `#/projects/tree/<id>` or `#/projects/project/<id>`):
what is going on with it across the top (what is live, a preview with its cut-over, Open app, sign-in, the last build),
each tree as an epic with its features (branches) as rows and its stories (leaves) as cards in the state columns
(`BOARD_COLUMNS`/`stateFor`, the one rule for a leaf's column; `board.ts` builds it), and the channel on the right, its
width dragged (and kept) at the divider. Opening a card or a feature puts it on its own page in place of the board, with
breadcrumbs back up (`…/<branchId>/<leafId>`, `…/<branchId>`; each opening is a history step), and its chat on the right
beside the Channel and Threads tabs. You set the order work is taken in on the board: drag a card by its grip within its column, move a feature with its arrows (`PUT /api/branches/:id/order`, `PUT /api/trees/:id/order` → `priority` on stories and features, `GroveOrderService`); `ready_leaves` takes ready stories in that order (`lib/work-order.ts`), so the fan-out starts yours first, and Koala's outlines list them in it. A story's page lists its tasks, with Accept and Drop for any proposed while it was worked, and "Watch it work" opens the live feed of its worker's run and the runs it starts (the tree run's turn, `turnId` on `GET /api/trees/:id/run`; `GET /api/turns/:id?under=<runId>` sends only that run's family, with `through`, the last seq it read). Each run is a tab (`Board/StoryRun.tsx`): its procedure on the Studio graph, read-only, following and centring on the step it is on, and its rounds (`lib/run-rounds.ts`: a round starts each time the model step is entered again, since the log has no `model.requested`; a tool the procedure calls itself, a `call-tool` trace, is shown apart from the model's). The turn log writes a step's node events when the workflow step ends, so the model call is only "entered" once it has answered; streamed thinking and text carry its node, and the run state takes the step from them. A `node.traced` event in the turn log is a summary (`tracedSummary` in `lib/turn-log.ts`: no `inputs` or `outputs`); the full trace is only in `engineRunTraces` (`/engine/runs/:id/traces`, which checks read), and the Studio's run panel reads those every few seconds while a run is live. Each trace used to carry the whole conversation, which made a long run's log tens of MB and crashed the tab watching it. A story that can be started shows the tree's run panel on its page: there is no running one story, the tree takes the ready ones in board order. The editor, explorer, builds, workspace file and the tree's sandbox are its **Files** page (`…/files`); its models, auto mode, how its project releases and deleting the tree or project are its **Settings** page (`…/settings`, `Projects/Settings/`); the switch at
the top. All three read the project through `useProjectWork` and keep the address with `useRouteSync`.

**A story and a feature each have their own chat** (`ItemChatService`, `POST /api/items/<story|feature>/<id>/chat`,
`story-<leafId>` / `feature-<branchId>`, `kind: 'item'`, bound to the leaf or branch and its tree, made the first time it
is opened). On every turn in it Koala is handed the item (`conversationBinding` → `story` / `feature`, written by
`lib/item-outline.ts`): where it sits, its brief, what it waits on, its tasks, what was claimed, the judge's verdict and
the attempts that failed. Every chat bound to a project, a tree or one of its items is also handed the status of each of its projects — what is live, a preview waiting on the person, a release in progress, the last build (`lib/project-outline.ts`). Every chat bound to something (a project, a tree, a feature, a story) opens with what Koala is handed on each
message, read fresh (`GET /api/conversations/:id/context`, `openingWith` over the same binding a turn gets;
`Chat/ConversationContext.tsx`), formatted, with the exact text a click away. In a story's or feature's chat Koala changes the work only through a card: `propose_story_change` (title, goal, brief, waits-on, tasks, rework), `propose_stories` (new stories in a feature, or a follow-up to a shipped story, which is never changed) and `propose_story_cancel` make a plan proposal with a `change` (`lib/item-changes.ts`), shown on the plan card in that chat, and nothing changes until it is approved. `AdoptPlanWorkflow` applies it: it first stops the worker of a story that must start again (a running story whose title, goal or brief changes or that is reworked; a claimed one has its claim set aside), saves the records, rewrites `leaves/<story>.md` and notes the change in PLAN.md, and runs the tree only when work was put back in line. A run a story was taken off can no longer claim it (`claim_leaf` checks the story's attempts). Cancelling frees the stories that waited on it. A notice about one story (a failed leaf) is posted in full in its chat and as one line with
"Open the story" in the channel (`line`, `open-story`); item chats are never a tree's threads and never hear the tree's
own notices. A check stage talks in one with `chat.in: { story: title }` or `{ feature: title }`, and approves a card there with `approvePlan: { in: … }`;
`mechanics-item-chats` proves it, change card included.
In the channel a message is just posted (`POST /api/conversations/:id/messages`, only channels) unless it names @koala or the person has turned on "Ask Koala" beside the message box (remembered per channel in their browser, `lib/channel-asks.ts`); then it starts Koala's turn. Every person message in a channel says which it was ("asked Koala" if it carries a `runId`, else "posted · Koala wasn't asked" with **Ask Koala**, which starts a turn with `asks: <its at>` so that note is answered in place, never posted again; `openTurn` refuses one already asked about). A turn's history leaves out the message its own open turn is answering, since the opening already carries it with the context. In a channel or an item chat each person message in Koala's history says who wrote it (`heardAs`, by email), a channel post nobody asked Koala about reads "<who> posted, not to you:", and the binding's `chat` value tells Koala which chat it is in and who is asking (`chatFraming`), so it reads the discussion without acting on it. Other chats about the project are its threads. Approving a new tree's plan binds the
conversation it was planned in to the tree and its project. Releases (preview ready, live, failed), a tree's run ending
(and each failed leaf), and a secret only the person can enter post a notice — a third kind of message
(`role: 'notice'`, author `platform`, with links and actions) — to the project's channel (a tree with no project: to
the conversations bound to it), once per event (`ConversationNoticeService`,
`lib/notices.ts`), pushed live as `conversation-notice`. Koala does not reply on its own; on the person's next message
it is given each notice as a message labelled "From the platform, not the person:". Koala reads trees and releases with
`read_tree`, `run_tree` and `project_releases`; a plan's tree starts growing when it is approved.

**A tree type describes itself** (`TreeTypeDescriptions`, `lib/tree-type-description.ts`): what approving a plan makes
(`lib/tree-home.ts`), the starter's files, the workspace image's own summary, how the tree grows — the grove agent's
procedure and the agents it hands work to, each in its own words (`outlineProcedure` in the engine) — and what happens
to work that lands (`lib/delivery.ts`: the release text is keyed by every `ReleaseState`, so a new state must be described),
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
`lib/tree-models.ts`). The tree's Settings page lists each agent in its type's work that asks a model (walked from the grove
agent's procedure, `modelAgentsOf`), with what it would use on its own; a choice there is for that tree only, and is
read when each of the tree's runs starts: the grove agent's by the launcher (`modelFor`), every run under it by
`EngineResolveAgentActivity` from the run's root id (`treeOfGroveRun`), so in a tree's run an agent gets the tree's choice
or its own model, never one handed down from the run above it (the judge stays on its own while the executor is moved).
A machine is not offered yet, and an agent whose "Runs on" is a machine keeps it. A chosen model that is gone shows on
the panel and fails the agent's runs with its name. Koala reads the models in `read_tree` and `run_tree` and proposes a
change with `propose_tree_model` (card `set_tree_model`); `mechanics-tree-model` proves it (expectation `treeModels`).
A `choose-model` trace keeps the model's name in its summary, so a story's run shows the model each round ran on.

**Every workflow says whose it is.** Each start carries the `KoalaOwner` search attribute (`startedFor(owner)` in
`lib/workflow-owner.ts`; `platform` for platform work). The shared client (`lib/temporal-client.ts`) registers the
attribute on connect, refuses a start without it (`UnownedWorkflowError`), and stamps a check space's workflows as its
person's. Child workflows inherit their parent's owner. The Temporal page lists, counts, opens and cancels only the
viewer's own; an admin can switch to everything, and an instance's owner sees everything on it. Workflow tests create
their server with `workflows/temporal-test-env.ts`, which registers the attribute.

**Large payloads are stored outside Temporal.** Every Temporal client and worker builds its
converter with `buildDataConverter(key, sharedPayloadBlobs())`: payloads are compressed, then
encrypted, and any still over 128 KB go to Mongo `temporal_payload_chunks`, leaving a claim in the
history (`lib/payload-storage.ts`, Temporal's `externalStorage`). A new process that talks to
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
  target shape.
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
