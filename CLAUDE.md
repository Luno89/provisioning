# CLAUDE.md

Rules and decisions for working in this repository. How the code carries them out lives in the code and its tests, not here
(owner, 2026-11-11: "I really don't think its important to update the claude.md with specific implmentation details that are
going to drift if the code changes"). When a change lands, add only the rule a future change must respect, in a sentence.

## Where the work stands

- **The plan is `~/.claude/plans/backend.md`** (approved 2026-11-05, evidence in `~/.claude/plans/backend-audit/`), progress in
  `~/.claude/plans/now.md`. Owner: "I'm looking for structual changes in how we work cause its been like three months and we
  haven't really gotten anywhere", then "yes, the GPU machine story is v1, and your going to do all the structural changes first
  right?"
- **v1 is done (2026-11-17)**: a person joins their GPU machine, Koala runs on it, they deploy TabbyAPI or vLLM and chat with their
  own model, signed in through root. The areas frozen during v1 (the hub, Odoo releases, the pool, the marketplace, payments, checks
  and the bench, memory, telemetry extras) are open again. The plan's phases 3 to 5 now cover every area, and its deferred list is
  taken up as each area is worked.
- **Staying aligned** (owner, 2026-11-06: "I feel like its important we don't drift from each others understand, and that you ask me
  about inconsitances before we keep developing any more"; plan `~/.claude/plans/alignment.md`):
  - Before asking the owner anything, find what they already said with `npm run said -- <words>` and quote it. Never restate a
    decision in other words.
  - Product questions are settled first by "always side with the user and whatever decision makes it easier and less invasive to
    them" (the user being whoever uses Koala).
  - What we agreed lives in `tests/alignment/`: each decision once, in the owner's words with when, and each v1 step. `npm run
    decisions` holds every quote to the transcripts.
  - Before each development step run `npm run drift`. Every finding for the owner is asked before code and recorded as asked, or as
    noted with why. Ship refuses while one is neither. "Decided, not done" findings are the work list, not questions.
- **A change list comes from the coding tools, never from grep** (owner, 2026-11-08: "grep isn't the right tool most of time why do
  you keep using it"). The `change-list` skill is the procedure: each affected flow from its frontend action to every way it ends
  (`npm run flows`), and every symbol touched through `npm run refs` and LSP, tests included. Grep is for literals, logs and plans.

## What Koala is

A person's own Koala on their own machines. It deploys apps (vLLM and TabbyAPI first, then Odoo, WordPress, Nextcloud,
Audiobookshelf, Open WebUI and others) and runs agents that work on the person's projects.

- **Root** holds accounts and signs people in (it is the OpenID provider for everything else), routes addresses through its Caddy,
  runs the mesh (Headscale), sends mail, keeps the release catalogue and offers trials on the pool. It keeps one k3s cluster of its
  own.
- **A machine** is one of a person's computers, added to their account at root, and is exactly one cluster: native k3s (needed for
  GPU passthrough) or k3d in Docker without it. It starts its cluster when something runs on it and stops it when idle. Its agent
  also runs coding agents (Claude Code, Codex, Gemini, Antigravity, Goose) over ACP.
- **An instance** is a person's Koala: the instance chart's pods on one of their machines, or on the pool. It serves one owner and
  signs people in only through root.
- **The hub** holds projects shared between people; the owner's instance keeps the working copy.
- **The pool** is Koala's servers, where someone without a machine tries Koala in a sandboxed vcluster and can move to their own
  machine later.

Koala makes no clusters (owner, 2026-11-08): a cluster comes with a machine and goes with it. There is no other kind of cluster. The
`combined` role, mock cloud, Hetzner, DigitalOcean and "Provision a cluster" are gone (owner, 2026-11-08: "Ok I think those are all
good, sweet").

npm workspaces: `apps/*` (backend, frontend, local-agent: the machine agent) and `packages/*` (engine-core, agent-engine,
context-engine, harness-types, cdktf-infra).

## Agent Rules & Standards

1. **Zero half-implementations.** Every feature is implemented end to end: backend, persistence, API, UI, real-time events and
   tests. Each of these shipped in this repo and passed its tests:
   - a control the server never reads;
   - a fake that passes by construction;
   - canned tool handlers standing in for real ones;
   - an invented placeholder shown as real;
   - data kept only in memory when it is history the user comes back to;
   - a field sent in a shape its consumer silently ignores.

   Test doubles belong in tests.
2. **Ask when not sure.** If requirements, terms, trade-offs or boundaries are unclear, check the plans, CLAUDE.md and the owner's
   words first, then ask with your reading in the question. Architectural decisions and UX shifts get the owner's sign-off. Bring
   proposals with their trade-offs, never "shall I".
3. **Live end-to-end verification.** Nothing is done on unit tests and typechecks alone: prove the user's flow against the running
   app through the real path. A run in a mock mode proves the mock. Say what was exercised live and what was not.
4. **No silent fallbacks** (owner, 2026-11-05: "you need to never do half assed shit like "skip" or fallback without making it explicit
   to me first, everything needs to be implemted cleanly"). No skip, fallback, "else the old way", guessed default for missing
   config, warn-and-carry-on, quiet degrade (CPU for GPU, missing as empty, an error read as "not running") or second path for one
   job without asking first. A missing dependency is an error with its reason or a state the person sees.
5. **Fix the model, not the symptom.** Find every place the same wrong model lives and fix them together. One path per job: a new
   feature that overlaps an existing one refactors it into one path ("There shouldn't be two paths").
6. **Map before code.** Read the flow map of the flow you change, and show the owner the flow before and after. Before each step the
   owner gets its exact list of changes and removals.
7. **Never weaken a test to get green.** No deleted test or suite, removed assertion, relaxed check, dropped gate step, grown coupling
   baseline or loosened coupling rule without the owner's yes. A test that fails is the code's problem; one that fails twice gets its
   audit and a code fix. A new test is watched failing first.

Also: no code comments; remove proven leftovers of an old model without asking (say so in the change list); never print or read
secrets; commit as work lands, and push only on the owner's say.

## Commands

```bash
sudo bash scripts/setup-root.sh  # once, on Linux: Docker, the docker group, firewalld
npm run setup        # from a clean clone: binaries, packages, CDKTF bindings, the platform keys
npm run dev:reset    # dev is disposable: removes this computer as a machine (its k3s and Koala), dev's databases, Temporal and Headscale
npm run dev          # root, its worker and the hub on this computer; the first time, this computer joins as a machine (one sudo prompt) and Koala installs on its k3s

npm run ship         # a fresh dev stack, then every ship step on this commit, then push main; run in your own terminal, once a day
npm run gate -- <step>  # one ship step alone against the running stack, its pass kept for this commit
npm run release      # the release gates on a shipped commit, then a signed tag; GitHub builds and publishes the image
npm run release:check   # the release gates on any commit, without tagging

npm run test         # the three tiers in order, each only once the one below passes
npm run test:unit    # typecheck and every workspace's unit tier (*.test.ts)
npm run test:integration  # every workspace's integration tier (*.integration.test.ts)
npm run test:integration:coupled  # the same, gathering what each test file runs for the coupling rules
npm run test:coupling   # the coupling rules over the unit and integration tiers, against their baseline
npm run test:e2e     # the live suites ship runs, against the running dev stack
npm run test:<name>-live  # one live suite (tests/<name>-live.ts); every run records its pass or failure
npm run test:vm-live [suite…]  # the VM suites, packed into rounds by free memory
npm run lint

npm run flows        # flow maps and the concept index from the coupling graph
npm run refs -- <file> <Symbol>  # every reference to a symbol across the workspaces
npm run said -- <words>  # the owner's own words across every session
npm run decisions    # the decisions register held to the transcripts
npm run drift        # where agreement and code part

npm run pins:write   # write every pinned version and checksum from dependencies.pins.json into the files that name it
npm run deps:update -- <package>  # take a vulnerability fix that is due
```

Single test file: `npx vitest run <path>` from its workspace. Per-workspace scripts: `npm run <script> -w <workspace>`.

**The live suites.** Which ones ship runs and which the release runs are the gate lists in `tests/lib/gates.ts`. A suite that needs
this computer's machine agent or a model's own judgement runs by hand. Ship runs `gpu-live` and `v1-live` (v1 end to end in Chromium)
on this computer's GPUs. `tests/LAST-PASSED.md` shows when each last passed.

## The dev stack

- **Dev runs as production does** (owner, 2026-11-05) and is **disposable** (owner, 2026-11-14): `npm run dev:reset` removes
  everything dev made, and the next `npm run dev` builds it again from nothing. Nobody keeps their own Koala on it.
- `npm run dev` runs root (API :3002, web http://koala.localhost:5175, sign in there), its host worker and the hub (API :3003, web
  http://hub.localhost:5176) as processes on this computer. Your Koala is the instance chart's pods on this computer's k3s, running
  this checkout under a watcher, its backend on :30320 and its web at http://dev.localhost:5173. Port 3001 is not used.
- **Everything hot-reloads, and a reload kills what is running.** Saving a file a worker imports restarts it, and a step that is not
  idempotent gets one attempt, so a save during a live run can fail the run. Wait for it to finish.
- Never touch `apps/backend/.env` or `apps/backend/data/`, and never drop the old `provisioning` database.

## Security and accounts

- **Accounts live on root** (owner, 2026-10-26). An instance and the hub make no accounts and sign people in only through root's OpenID provider. The
  first account needs the setup code; every later sign-up needs an invite and confirms its email before it is an account (owner,
  2026-10-28). Nothing tells a stranger whether an address has an account.
- **Who may do what is decided in one place**, the permissions table, which every route, socket handler, service and tool call asks,
  and the browser asks the same answers. A person is a set of claims (operator, instance owner, a role on a shared project), never
  an `isAdmin` shortcut. Adding a permission is a row in the table and a call where the action happens.
- **Every signed token says what it is for**, and a session ends on the server when signed out. Revocation is one event: signing out
  everywhere, a password or two-factor change, an account's removal or a hub removal ends that person's sessions, connections and
  runs' grants at once, on root and on every client.
- **Risky changes ask for proof** (owner, 2026-10-30): turning two-factor on or off, changing the password and removing the account
  take a current code or the password. Wrong passwords and codes lock per account, never the person out of their own browser, and
  the person is told once (owner, 2026-10-30).
- **Limits** are per address and count only failures where a person succeeds and a guess fails. An address on the open internet
  may have only so many requests open at once, a cap that adapts, in place of an idle timeout, which would be a deadline (owner,
  2026-10-28).
- **Nothing next door can act as you** (owner, 2026-10-25): people's addresses are under a registered domain of their own, never
  root's; cookies are `__Host-` over https; a cross-site write is refused.
- **What Koala fetches for a person stays on the open internet**: no private, loopback, mesh or metadata address, at connect time and
  on every redirect. A lab may reach loopback (owner, 2026-11-03).
- **Temporal answers only what Koala's own processes sign** (owner, 2026-10-27), each token for one role on one namespace, over TLS
  to a CA of the install's own. A machine reaches Temporal only through the machine gateway, which serves only its own queue.
- **An instance's internal services answer only its own pods.** On a person's machine nothing of the instance answers on the
  machine's network address; NodePorts answer on loopback and the mesh only.
- **Secrets never reach a model or a Deployment.** An app's passwords and tokens are in a Secret it reads by reference. An app's
  sign-in is generated per deploy and shown only on asking (owner, 2026-10-27). Stored secrets are sealed with the data key, and
  every key comes from the role's settings, never a literal.
- **A pattern a model, the keeper or a person writes runs on RE2**, so it cannot freeze the engine.
- **Signing in with Google, GitHub or an organisation's own OpenID provider** happens only on root, each provider one description
  and one client. A provider joins an existing account only by a verified email the account confirmed. There is no pretend
  provider; tests run a real one on loopback.

## Account and project removal

- Removing an account removes everything it owns, the account last. On root and an instance, an account is root's.
- Every collection says how account removal removes it; a test fails on one that does not.
- Removal and project deletion **fence** what they remove before stopping anything, and go on only once every live process holds
  the fence (owner, 2026-11-13: "C sounds right", "with the confirmation step"). No timer is waited on. A fence outlives its removal
  until every process live then has restarted (owner, 2026-11-13: "drop them after every process restarts").
- Workflows are stopped by cancelling, never terminating, so a run hands its claimed work back.

## Machines

- A machine is added at root with one command, is one person's only, with no limit on how many (owner, 2026-11-04: "adding a machine
  is the core product"). Running the command again replaces it. Removing it uninstalls what the join installed and nothing of the
  person's own.
- The join asks for sudo once, for k3s (installed stopped) and, with an NVIDIA GPU, NVIDIA's container toolkit for CDI (owner,
  2026-11-13: "C sounds good"). A k3s of the person's own is left alone.
- Koala is put on a machine only through the machine join and root's install; a move from the pool is that install carrying the
  pool's data, and it renames the moved records onto the machine's cluster. While it moves only what needs no service is restored;
  the rest comes over as the last piece of the provision procedure.
- The machine's own report is the only source of its GPUs, cores and memory. A machine that has not reported is shown so, never
  guessed.
- A device token lives 90 days and rotates over the authenticated socket; Koala keeps only its hash.
- **A machine's agent updates itself** (owner, 2026-10-30), only while the machine is idle, only to the bundle Koala names, checked
  by its sha256. A session never outlives its run.
- An agent on a machine is told everything a model is, gets its persona's tools through Koala, and works a checkout of the
  workspace on the machine. Its work comes back merged, never refused: a conflict is handed back to the agent to resolve, and what
  it cannot resolve is kept as a branch. Work handed on is merged into its folder (owner, 2026-11-05).

## GPUs and model servers

- A deploy that asks for GPUs is decided by the machine's report: the count it names (1 or more; owner, 2026-11-13: "I don't want to
  offer any inference deployments targeting the cpu"), the vendor, and CDI support. A refusal says what to do.
- Koala readies the GPUs itself: it applies the vendor's pinned device plugin and waits until the node advertises them.
- GPU passthrough needs native k3s; k3d never gets a GPU.
- vLLM and TabbyAPI run the build Koala pins unless the person picks another, and the page says which they run.
- A model's Hugging Face token has one path: typed in the wizard, else the person's saved credential, else none. No process takes
  one from its environment.

## Configuration and roles

- **Each process reads its settings in one place**, its role's reader, and gets typed settings or stops naming every problem. Nothing
  else reads the environment.
- A setting is one of four things: **required** (the process stops naming it), **off with a reason** the person sees, **a constant**
  in code, or **a test parameter**. Half of a feature is a problem, never off. Adding a setting means reading it in the role's
  reader, setting it in every writer, and extending the writer tests.
- **`ROLE` is root, instance or hub**, each exactly one thing. A process started without it stops.
- **Where work runs is no setting** (owner, 2026-11-10): every queue and the roles that run it are named once in code.
- Five platform keys, one per purpose; no process starts without them. Nothing is derived from an old secret any more.

## Clusters

- **`ClusterAccess` is the only way to reach, start, stop or check a cluster, and the only caller of kubectl and helm.** Lint refuses
  either anywhere else. The machine agent, a separate program on the person's machine, is not held to it.
- Every cluster that runs apps has monitoring before an app is deployed on it; an app never goes on without its probe.
- An app's name is unique per owner, and its namespace carries its own id.
- Terraform's state on an instance lives in Kubernetes, a Secret per stack, locked; root keeps it in its data folder.
- **Terraform waits on nothing it makes** (owner, 2026-11-09: "1 for helm"). Koala watches the rollout itself and stops Terraform the
  moment a workload can never recover.
- Koala's own chart is applied by one install step (machine, pool, self-upgrade and dev alike) with helm waiting on nothing; its setup
  steps are ordinary Jobs per revision that wait on what they need, and putting Koala on a machine is a workflow on root that the
  machine's agent carries out (owner, 2026-11-18: "The agent, driven by root").
- A Koala's platform services and monitoring are set up only by the provision procedure: on every new chart revision, when a piece
  is found missing, and when the person asks; root's ready waits for it. Each service is a CDKTF stack applied through that same
  watch, taking over what is already there; their secrets live in Secrets Koala makes, which the stacks read by name.

## Outside dependencies

Owner, 2026-11-08: "it should be a layer for any dependency that might be slow or can be retried"; "if a dependecy is down we should
inform the user and have metrics alerts and best practices around our dependecies". Then (2026-11-09): "yep go for it".
- Each dependency is described once, with its state, shown under Needs attention and measured. One HTTP client and one backoff serve
  every call.
- A caller of a dependency that is down is answered with its state (503 with since and why). Nothing falls back to something else:
  web search is SearXNG, pages are Crawl4AI, recall fails with why.
- One rule decides temporary or final. Opening a connection has a limit; an answer never does.
- Adding a dependency: its description, the processes that use it, its check, and its client reporting to it.

## No deadlines

Nothing has a deadline: work ends when it finishes, fails for good, or is stopped.
- Activities heartbeat so a dead worker is noticed in a minute, and a slow one is never cut off.
- A wait ends on the thing it waits for or on a state that will never recover, never on a count of tries or a clock. That holds in
  tests too.
- Model calls, commands, sandboxes, builds, releases and people's answers wait as long as they take, unless the person set a limit.
- A model going in circles is asked again, not stopped, until it circles the same way twice.

## Temporal

- Temporal is not optional and there is no polling fallback. A backend whose Temporal is down still starts and says so.
- A record names its workflow only once the workflow has started, and the backend follows every one to its end.
- Every workflow says whose it is; a start without an owner is refused.
- Payloads are compressed and encrypted, a plaintext one refused, and large ones stored outside Temporal. Every new process that talks
  to Temporal uses the same converter.
- Workflow code imports only pure code; Temporal bundles it.

## Files and data

- Code is in git; records are in Mongo; every other file is on the instance's own MinIO. There is no fallback store.
- Overwriting a file asks (owner, 2026-11-07: "make sure the user is aware they would overwrite it"). Room is checked before an
  upload and the person is told when it would not fit (owner: "the size should be calculated before the upload and inform the user if
  it wouldn't fit"). A drop is one batch, all or nothing (owner: "I'm ok with a batched approach").
- Share links follow their file and stop when it moves or goes. A person's file is served only in a type Koala judged.
- Mongo is a replica set. A field left undefined is not stored.
- Startup migrations run once, by name.

## The engine

- **An agent never lists its tools.** It holds grants: shipped, granted or revoked. A built-in agent stays built in when only its
  tools change. MCP servers are a catalogue of their own, offered only while their capture matches how they run.
- **Every run works with a grant** that ends with the run or on revocation; every tool call is checked against it.
- **Asking before a call** is separate from what is allowed: on a person's own machine every call asks, elsewhere a destructive tool
  asks, and auto mode (per agent, tree or chat) turns asking off.
- **Poisoning is noticed, never blocked** (owner, 2026-10-28: notice it, never block or ask). Hidden text never reaches the model. A
  call the watch could not check goes on, and the person sees it (owner, 2026-11-13).
- **Memories are made by the memory keeper**, driven by events, never by a hidden model call.
- **Checks** run each scenario in a fresh hidden space that is removed afterwards. Every mechanics check passes on an instance except
  those marked with why (owner, 2026-11-09). A failed check says where it failed (owner, 2026-11-09).
- A tree's workspace is composed, built and published; a task that needs what is not built yet waits for it, never fails.

## Projects, the hub and releases

- A project's channel hears what happens to its work. Koala changes work in a chat only through a card the person approves.
- Every member of a shared project sees everything in it (owner, 2026-10-26: "we can pair it down later"). Koala acts for the member
  who asked and reaches nothing outside the project; an MCP server is a tool (owner, 2026-10-26).
- Invites that would make an account are limited per person (owner, 2026-10-26).
- How a project's builds are released is a procedure its type names. A release that would lose something the person made waits for
  them to see it. The cluster is the truth for which slot is live.

## Monitoring, mail and telemetry

- The browser never sends PromQL. What is not measured is said to be unmeasured, never shown as fine.
- Alerts reach the person once as they fire and once as they resolve.
- Root sends its own mail; an instance sends through root, only to its owner.
- Nothing a person typed enters telemetry: ids, counts, durations and names only. Telemetry never waits and never retries.
- Root and each instance know the other is there through one open connection, not polling.

## Root, DNS and the mesh

- What an operator does by hand is in `docs/runbook.md`.
- Root's scripts are idempotent and refuse loudly rather than half-succeed. An update builds and checks before restarting, and rolls
  back on failure. Rollback is git-based; snapshots are disaster recovery only.
- **Root moves only onto a signed release** (owner, 2026-10-25), and never builds an image outside a lab. A lab is only a domain
  nothing public resolves.
- **Each DNS provider is one description and one client** (owner, 2026-10-29: Porkbun beside Cloudflare, nothing hardcoded to either).
  Koala never rewrites a DNS record it did not make.
- Headscale's policy is required; with none it allows everything.
- A GitHub token is no longer kept (owner, 2026-11-08: "yep remove it and track the mirror for later").

## Releases: every gate before what it protects

Owner, 2026-10-23: "all those checks need to run before it gets to main". Plan: `~/.claude/plans/release-pipeline.md`.
- **Ship** is how `main` is pushed: typecheck, the unit tier, lint, the integration tier, the coupling rules, then the live suites,
  from a fresh dev stack, on a clean checkout of `main`. The mechanics checks fail whenever a check fails (owner, 2026-11-06). It runs once a day, in the owner's own terminal. Known vulnerabilities are
  listed, never a block (owner, 2026-11-09: "thats a guideline it shouldn't block anything").
- **A release** runs the VM suites and the release rehearsal on a shipped commit, then signs the tag. GitHub builds, attests and
  publishes the image; nothing from GitHub runs on root, and no CI repeats ship (owner, 2026-10-24).
- The pre-push hook refuses `main` without a ship record and a tag Koala did not sign.
- **Every version, checksum and chart repository is edited in the pins file alone** (owner, 2026-11-17: "reconcile them into that
  dependencies.pins.json file"). Every installer checks a checksum before it runs.
- **Each instance's updates are its owner's** (owner, 2026-10-24): automatic by default, or a picked release. A release root rolled
  back from is withdrawn (owner, 2026-10-29). An instance never moves below its data (owner, 2026-11-16).
- **An upgrade drops no request** (owner, 2026-10-27: drain on events).

## Tests

- **Three tiers, run in order** (owner, 2026-11-02): unit (one process, every dependency mocked through a library), integration (the
  real dependencies on this machine), e2e (real Koala processes on the dev stack or a VM). Each concept is tested at each tier.
  Plan: `~/.claude/plans/testing-pyramid.md`.
- A unit test cannot reach outside its process. An integration test never touches the dev stack.
- **Each integration file works in a clean world of its own** (owner, 2026-11-11), touching nothing another file can see, and
  waits on the condition it needs. A failure only in a full run is the setup's fault.
- **A mock is held to the real thing** by one contract suite run against both.
- Every test asserts something, and no tier passes on no files.
- **A test that fails twice** (owner, 2026-11-02: "tests should be the signal something is wrong, if we have flaky tests we have flaky
  code, if a test suite fails twice that should trigger an audit and research around how to implement the code better"): failures are
  recorded for gates and live suites always (owner, 2026-11-06: "Gates always, live suites always"), and twice since its last audit
  blocks ship and release until the audit and its code fix are committed. Never a rerun, a longer limit or fewer workers.
- **Coupling coverage**: the coupling rules judge which calls a test runs for real, from the unit and integration tiers only (owner,
  2026-11-10: "lets go with A"), never mapping test code (owner, 2026-11-09: "I don't think we need to map the test code, just the
  implementation"). The baseline only shrinks. A breach that comes and goes is a fault in the code.
- A test never re-declares the logic it tests, and tests what people notice, never a log line.

## Structure rules

Enforced by lint; each is here because something broke without it.

**Both halves**
- Laid out by area, the same areas in the backend and the frontend. An area imports another only through its `index.ts`. Find a file
  by area first.
- Domain shapes are declared once. A deliberate copy across the wire is marked `── DUPLICATED, KNOWINGLY ──` and names the file that
  wins.
- No copied code (owner, 2026-11-18: "I would prefer none"), in source or tests; the copies there are only shrink, and a deliberate
  copy is marked `── DUPLICATED, KNOWINGLY ──` naming its other file.
- Apps import packages; no package imports an app.

**Backend**
- Inside an area the arrow is one-way: wiring → routes → services → lib. `lib/` is pure.
- An area's records are its own store; nothing else reaches the driver.
- A route reads the request, authorizes, calls one service method and shapes the response. Every async handler is wrapped.
- Something is a service when it holds state, owns a resource or is the only writer of a collection; otherwise it is a `lib`
  function.
- Route order in the backend's bootstrap is load-bearing.
- No value-import cycles; tsc cannot see them.
- Relative imports need the `.js` extension.

**Frontend**
- Server state belongs to react-query; client state that crosses components is a zustand slice per domain; UI state stays in its
  component.
- No component contains a URL. No `props: any`. Pass a named intent, never a raw `setState`.
- PascalCase files export a component, kebab-case files none. Logic that needs no React is a pure, tested `lib` function.
- Imports are extensionless.

**TypeScript**: `verbatimModuleSyntax`, `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on. Typecheck is necessary
and not sufficient: run the suite and hit the route.

One-time setup: `git config core.hooksPath .githooks`.
