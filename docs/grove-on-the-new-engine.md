# Grove on the new engine — migration plan & tracker

Living document. Updated as we work. **Current focus: P0 — the leaf/tasks model (implemented; full gate green 2026-07-22).**

Last updated: 2026-07-22

## Status

| Phase | State |
|---|---|
| P0 task/leaf expansion + shared parts | **implemented** (model + extended planner + tests; gate green; commit pending) |
| P1 leaf execution on engine lanes (coexistence) | not started |
| P2 planning + launching in engine | not started |
| P3 landing as engine tools | not started |
| P4 supervision swap (retire LeafWorkflow) | not started |
| P5 grove surface on engine + grove UI flip | not started |
| P6 legacy deletions | not started |

Decisions (a–e) from the original plan: **all open** except the model change below.

## VERIFICATION FINDER (2026-07-22, engine side)

The bridge between the two worlds already exists in the repo:

- Durable **`Task`** model (`apps/backend/src/lib/tasks.ts`):
  `proposed | accepted | running | done | failed | dropped`, with `doneMeans`,
  `checks`, `dependsOn`, `parentTaskId`, `agent` (slug), `runs: string[]`
  (engine run ids), `evidence`, `projectId`.
- Engine host `TaskStore` is **already backed by** `db.saveTask/getTasks`
  (`engine-host/host.ts`, `worker-engine.ts`); engine agents call `start_task` /
  `mark_done` on these docs via `task-tools`.
- `GET/POST /api/engine/tasks` + `/tasks/:id/accept` + `/drop` endpoints exist
  (`routes/engine.ts`).
- Frontend `EngineRun/TaskBoard.tsx` already renders engine tasks (with tests).
- The engine's `do-one-task` procedure already runs the *shape* of leaf work:
  work → evidence → `mark_done` → judge reads the verdict (pinned by
  `apps/backend/src/engine-host/nodes/nodes.test.ts`).

Grove today: `Tree` (goal+type) → `Branch` (plan direction) → `Leaf` (work item
with `dependsOn`, 9 validation-check types, attempts, evidence, persona + MCP +
local target + git branch + budget policy), driven by ~10 Temporal activities
(PlanProject, ExecuteLeaf, JudgeLeaf, Replan, Land/Accept/ResolveLanding,
UpdateLeaf, LeafGate) and the `LeafWorkflow` + interpreter supervisor.

## THE MODEL (revised 2026-07-22)

Original draft mapped leaf ⇄ task 1:1. Revised after discussion:

```
Tree            goal + type (provisioning project)
 └─ Branch      a plan direction / roadmap
     └─ Leaf    a goal broken down from the branch (what must become true)
         │        judged against its goal; board columns stay leaf-driven
         └─ Task  engine work items UNDER the leaf (how it gets done)
              │     agent-slug, doneMeans, checks, dependsOn (same-leaf),
              │     runs[], evidence
              └─ Run    engine lane runs that did the work
```

- A leaf **contains one or many tasks** (0 while planning; board treats an
  empty-but-accepted leaf as eligible for re-plan, not failure).
- A leaf is the unit of **judgment and board status** (`status`, `verified`,
  `merged`, `attempts` live on the leaf, as they do today).
- A task is the unit of **engine execution** (claim, run, evidence, retry).
- "Claimed" (agent claims it, nothing verified the goal) = all leaf tasks done
  but leaf not yet judged.
- Task `dependsOn` is **same-leaf only** in v1. Cross-leaf order stays on
  `leaf.dependsOn` (a leaf with an unfinished dependency is blocked → its
  tasks are not claimable). One block decision point instead of a distributed
  DAG.
- Replan = add/freshen the tasks under a leaf (leaf goal text is the judging
  contract; planner can also amend the goal).

Task agent default: inherits the leaf's `persona` (→ slug), overridable per
task with `task.agent`.

### Data shape (additive only — no rewrites)

- `Task`: add `leafId?: string` (skip `treeId` for now — derive through the
  leaf: `task → leaf → tree`; revisit only if a rollup proves it's needed).
  Add `description?: string` (the task's **full description**) and
  `role?: string` (**the part it plays in the overall project**). Both are
  **required when `leafId` is set** — enforced at `propose_work`, absent
  otherwise, so the non-grove engine chat-task flow keeps working.
  `checks` gains the 9 validation shapes from `ValidationCheckDefinition`
  (subset first: file-exists, content-matches, run-command, http-probe;
  then mcp-probe, k8s-probe, git-tracked, wait-for, custom).
- `Leaf`: add `tasks: string[]` (ids of tasks under it). Everything else on
  the leaf stays — it now has the semantics it was reaching for.
- Mongo: plain document fields, no new indexes needed (repo convention).

### Judgment with 1:N

1. Planner emits leaf + its task DAG (tasks reference `leafId`, deps within
   leaf).
2. Execution: "claim a task" = pick an open task of an *eligible* leaf
   (leaf state not blocked/running/failed). Each task → engine lane run of
   the task's agent procedure; `mark_done` captures evidence.
3. When all non-dropped tasks of a leaf are done: a **judge step** compares
   collected task evidence + tool output against the leaf goal
   (`leaf.body` + branch context) → `leaf.status = succeeded`,
   `leaf.verified = true` on a clear pass; succeeded-unverified ("claimed")
   when evidence is thin.
4. Judge fails → leaf `failed` + reason; Replan (same P2 procedure) can
   append tasks.

## Concept map (superseded-mapping column kept for audit)

| Grove (legacy) | Engine target | Notes |
|---|---|---|
| `Leaf` (goal chunk) | stays a Leaf doc, **contains Tasks** | judgment + board unit |
| leaf execution spirit | `Task` → engine lane run | unit of work moved to engine |
| leaf status+verified | leaf keeps them; tasks carry `TaskStatus` | claimed = tasks done, leaf unjudged |
| leaf validation checks | `TaskChecks` (9 types) executed per task; judge decides leaf pass | matrix see gaps (#2) |
| leaf `persona` | leaf default for task `agent` (slug) | pack→agent seed mapping |
| `Tree` | stays Tree doc (goal + type) | planner input |
| `Branch` | stays Branch doc; tasks carry `leafId` | name clash with *chat* branches is cosmetic — do not rename in DB |
| ProjectPlanWorkflow / planner | planner **procedure** on an agent emitting make-branch/make-leaf/propose_work DAGs | tools wrap the existing leaf/tree stores |
| ExecuteLeafActivity | `run-leaf` procedure: iterate open tasks of eligible leaf, launch lane runs | workspace parity: env-resolver + image-builder already in engine-host |
| JudgeLeafActivity | judge step in P0 judgment contract (above) | doTask pattern already exists |
| ReplanActivity | same planner procedure, scoped to a leaf | |
| Land/PR/merge (gitsnap) | **new engine git tools** + procedure steps | biggest real gap (#1) |
| branch notice / delivery | engine proposal → approval card surface (built in chat cutover) or kept as plain notification | decision (e) |
| leaf budget / pack policy | engine agent budget config | policy remap |
| leaf trace + explain | task `runs[]` → Runover link on leaf card; explain endpoint retargeted | view-layer, P5 |
| local-machine leaf runs | local lanes with approval mode | parity gap (#4) |
| chat launching (extraction / plan-mode → leaves) | extraction → leaf + `start_task` | writer swap, UI unchanged |
| judge/trajectory work-out proposals (leaves) | same, via engine task create | same board |

## Engine gaps (what the engine side lacks today)

1. **Git workflow** — no engine tool for push branches / open PR / merge-land
   (gitsnap seam where the leaf-code lives today).
2. **Validation matrix** — only command-style checks today; need
   file-exists, content-matches, http-probe, mcp-probe, k8s-probe, git-tracked,
   wait-for, custom-step as engine-check implementations.
3. **Temporal supervision vs lanes** — engine lanes have guards/revival/courier
   (new); LeafWorkflow+interpreter gives *proven* retry/settlement today.
4. **Local target parity** — engine local lanes run the device agent's
   procedure; leaf local runs use local-machine workspaces with approval modes.
5. **Budget policy** — pack policy/extension/token scaling → engine agent budgets.
6. **tree type / persona mapping** — executable persona files → engine agent
   seeds.
7. **Board projection** — grove board reads leaf docs (rollups incl. tokens);
   TaskBoard reads task docs. One must facade the other until P5 flip.
8. **Work-out/judge publishing** — should emit tasks (with leafId) not raw leaves
   (or, post-model, leaves that arrive with their task).
9. **Explain/trace formats** — different; join by link in P5.

## Phases

### P0 — task/leaf expansion + shared parts *(small)* — **implemented**

Locked model calls (2026-07-22, with owner):
- Planner is **one** engine `planner` agent, parameterized by tree type
  (per-type agents deferred).
- **A leaf may have zero tasks.** A task-less leaf is a valid "planned, not
  yet broken down" state, not a failure. The capability for **chat to talk
  about a leaf and plan its tasks** is a *later phase* (see P2 launch-from-chat);
  P0 only guarantees the shape leaves room for it.
- `propose_work` (the task tool) must **explain and enforce** the brief. A
  task under a leaf must carry: (a) what the task is — short, `title` (existing);
  (b) the task's **full description** — `description` (new); (c) **the part it
  plays in the overall project** — `role` (new); (d) how you'll tell it worked —
  `doneMeans` (existing). When `leafId` is set the tool **refuses** with a
  teaching message rather than defaulting — that is the "forced somehow": the
  model is sent back until it fills the brief.

1. `Task`: add `leafId?`, `description?`, `role?` (required for leaf tasks);
   `TaskChecks` gains a *flat slice* of the legacy check matrix — `fileExists`,
   `contentPath`/`contentPattern`, `httpUrl`/`httpStatus` (the rest of the nine
   shapes is P1, when the judge needs them). (db-interface + memory-db +
   mongo-db + types.) No `treeId` — derive through the leaf.
   **Model note:** the `Task` type exists in two copies — `lib/tasks.ts`
   (document/DB side) and `engine-host/tools/tasks.ts` (tool side; this one is
   what `task-tools.ts` actually imports). Any field walk must land on both —
   that is how the brief enforcement went missing on 2026-07-22: one copy was
   edited, and the wired copy was the unedited one. De-duplication is open
   (decision (b) below).
2. `Leaf`: add `tasks: string[]` (additive). `status/verified/merged/attempts`
   stay — the leaf is now the judged unit. A task that may be planned by chat
   later just stays absent, not a sentinel.
3. Extend the validator on `propose_work` (the `describeProblem` path in the
   **wired** copy, `engine-host/tools/tasks.ts`, mirrored in `lib/tasks.ts`): when
   `leafId` is present, refuse with a teaching message if `description` or `role`
   is empty; enforce **same-leaf-only** `dependsOn` (a dependency in a different
   leaf is a planner error; a dependency on a task with no leaf is fine).
   Both checks also carry through `newTask` — the first incident dropped the
   brief on save because the wired copy's constructor did not spread the new
   fields.
4. **No new `make-plan` procedure, no new agent.** The seeded `planner`
   persona (in `persona-records.ts`, procedure `planning` — an `agentLoop`) is
   *extended*: tools gain `make_branch` + `make_leaf`, inputs gain optional
   `treeId`/`treeType`, prompt gains the Grove protocol (branch → leaf with a
   checkable goal body → briefed tasks per leaf; zero-task leaves OK; same-leaf
   only; summary of assumptions). What it ships would need: two thin engine
   tool handlers (`grove-tools.ts` + `GROVE_TOOLS` catalogue) wrapping the
   existing tree/branch/leaf stores, registered in `ENGINE_TOOL_SEEDS`, wired
   through `host.ts` `stores.grove`, and `make_branch`/`make_leaf` added to
   `STANDARD_HOST_TOOL_NAMES` (the seeded-agent tool vocabulary gate).
5. Board `/api/trees/:id/board`: rollup may gain `taskCount` (additive);
   frontend untouched.
6. Tests: propose_work refuses a leaf task missing `description` or `role`
   (teaching → retry succeeds); same-leaf `dependsOn` enforced; the brief
   travels with the stored task; `make_branch` carries the tree project along
   and refuses unknown trees; `make_leaf` insists the goal body exists — it is
   what the judge checks — and refuses unknown branches/dependencies; seed and
   catalogue integrity (planner tools exist in the registered vocabulary;
   `GROVE_TOOLS` in `ENGINE_TOOL_SEEDS`). Plus one in-process planner run:
   seeded `planner` + real stores + scripted model drives branch → leaf →
   briefed task → summary. (The DB-implementation round-trip is implied: both
   stores persist whole `Task` documents with no per-field handling. The "claim
   rule" belongs to P1 with the judge.)

Ship reality (2026-07-22, same working day): the plan above landed as written
except item 4's shape — the planner is the *existing* seeded persona extended,
not a new agent, because `delivery` and `koala` already delegate to a `planner`
slug and an expectation test already listed it. A parallel work-session landed
`packages/context-engine` (context compaction, P5 territory) into `nodes/context.ts`
and the root gates; it runs green in the full gate and is tracked as P5, not
P0.

*No grove UI change. Acceptance: model + planner + refusal tests green +
full repo gate.*

### P1 — leaf execution on engine lanes, coexistence *(large)*

- `run-leaf` procedure: workspace+repo env (env-resolver/image-builder),
  iterate open tasks, lane runs, verification node from TaskChecks, judge at
  leaf end, evidence into task+leaf.
- `ExecuteLeafActivity` body → **launch engine lane run** (the LeafWorkflow
  shell stays until the coexistence window closes).
- **No per-tree flag.** The owner ruled (2026-07-22): the legacy engine is not
  kept alive — the cutover is global, and from it grove leaf work runs only on
  the new engine. P4's old-lane removal therefore becomes the *removal*, not a
  funnelling-over. The live-k3d-tree acceptance test stays, but it proves the
  one path, not an A/B.

### P2 — planning + launching in engine *(medium)*

- ProjectPlanWorkflow → make-plan lane run; ReplanActivity same procedure,
  leaf-scoped.
- Chat launching (extraction/plan-mode) + search-history launching →
  engine task/leaf create endpoints (exist/extend).
- tree type files → engine agent mapping; work-out/judge publishers →
  `start_task`/leaf-with-task. Acceptance: new tree born 100% engine-side;
  leaf writers gone from launch paths.

### P3 — landing as engine tools *(large)*

- git tools: ship-branch, open-pr, accept-merge, settle-tips — engine-host
  handlers on the gitsnap seam.
- run-leaf tail = landing step when `blocking`+merge needed; branch-delivery /
  notice / settlement semantics move into procedure+tools, activities go.
- Notice → engine proposal approval card (or plain channel — decision (e)).
  Acceptance: a merge-requiring leaf completes end-to-end via engine tools.

### P4 — supervision swap *(large, risky)*

- Replace LeafWorkflow+interpreter with lane guards: breaker (already in),
  revival/courier for liveness, retry-on-env-failure classification
  (from leaf-run-classify) as procedure node. Acceptance: crash-test
  (kill worker mid-leaf) reveals truthful state; healthy tree runs with zero
  leaf work packages left.

### P5 — grove surface on engine + UI flip *(medium-large)*

- Board reads tasks-under-leaves (facade first: leaf doc + `tasks[]` already
  enough for columns; rollups), then Projects/* flips to engine task reads
  + TaskBoard drill-down per leaf.
- Leaf cards link task `runs[]` into Runover; explain retargets.
- Local machine leaves via local-lane approval parity; budget policy → agent
  budgets; pack defaults drop. Acceptance: legacy leaf writers off; board &
  explain & rollup identity preserved.

### P6 — deletions *(medium, mechanical if flags stay clean)*

- agent-loop leaf path, Persona beats in grove, leaf temporal activities
  (keeping k8s/machine work outside grove), UniversalVerifier round loop where
  engine verification covers, leaf-libs gone into procedure/tool meaning.
  Acceptance: full gate green + lengthened machine test-step still green.

## Rollout

- **Global cutover, no per-tree A/B** — the old engine holding is decided
  dead (owner, 2026-07-22). Past state stays in the DB and keeps rendering on
  the grove surface; leaf work after the cutover runs only on the new engine.
- Every phase: full repo gate (`npm run test:unit`) green.
- P4 adds the crash-test protocol; P5 adds trace-equivalence snapshots
  (3–4 recorded leaves, legacy vs engine).

## Open decisions

- (a) Keep Temporal shell (LeafWorkflow) until P4? *Plan says yes* — not formally
  locked.
- (b) Grove UI: facade until P5 (plan) vs earlier TaskBoard flip.
- (c) Cluster/machine work flows (Temporale) stay outside; only env
  seam adapts.
- (d) Per-tree flag as rollover unit (not global env var).
- (e) Branch delivery/notice as engine proposals (appeal in chat) vs plain
  channel.

## Decision log

- 2026-07-22 — Plan drafted (original leaf⇄task 1:1 mapping).
- 2026-07-22 — Model revised: **leaf contains one-or-many tasks**; leaf = goal
  broken down from branch, unit of judgment/board status; task = engine work
  item under a leaf; task deps are same-leaf-only in v1. *(per owner)*
- 2026-07-22 — P0 locked: **one** `planner` agent parameterized by tree type;
  a leaf may have **zero tasks** (planned, not broken down — chat-based leaf
  planning deferred to a later phase); `propose_work` **enforces** a brief on
  leaf tasks via refusal — `description` (full task description) and `role`
  (part it plays in the overall project) are required when `leafId` is set;
  same-leaf-only `dependsOn`. *(per owner)*
- 2026-07-22 (later, during implementation) — The “one planner” is the
  **existing seeded `planner` persona extended** (tools `make_branch`/
  `make_leaf`, optional `treeId`/`treeType` inputs, Grove protocol in prompt),
  not a new agent: `koala` and `delivery` already delegate to a `planner`
  slug, and the seed-slug expectation test already listed it. Two planners
  would duplicate the picker, fork delegation semantics, and force a slug-test
  change with no behaviour gain. *(inferred from the existing seeds; owner
  unobjectionable = keep, flag on next review)*
- 2026-07-22 (later) — Task-model fork incident: the wired `Task` copy lived
  in `engine-host/tools/tasks.ts`, a parallel one in `lib/tasks.ts`; a brief
  enforcement + field added to the unwired copy and *dropped on save* by the
  wired one. Fixed by syncing both (checks shape, `describeProblem`,
  `newTask`). **Two doc copies of any engine model is the hazard** —
  de-duplication decision open until a dedicated green window (no emergency,
  nothing else touches these fields today). *(owner informed; no objection so far)*
- 2026-07-22 (later) — `packages/context-engine` (observation masking, token
  estimation, dual-boundary clipping, progressive compaction) landed as a new
  workspace package with its own typecheck/test entries in the root gate,
  and was wired into `agent-engine` `nodes/context.ts`. Independent of grove
  but adjacent (the P5 context/memory gap); it is **kept as-is** — green in
  the full gate has an own-lane tightness — and is classified under P5 in
  this document, not P0. *(parallel work-session on the same tree; owner
  to confirm scope on next touch)*
- 2026-07-22 (later still, owner rulings) — **(a)** *No coexistence of the old
  engine: the cutover is global; per-tree A/B is dropped* — leaf execution
  after the cutover runs only on the new engine; the legacy launch path is
  removed at P4. **(b)** *P1 shaping: the legacy activity capabilities are
  re-implemented as engine tools one at a time* — each lands only when its
  context is verified to reach the consumer it serves and the tool actually
  works on a tree. No batch port. **(c)** *Sandboxed runs need no approvals* —
  the approval gate exists only for runs that leave the sandbox. **(d)** *The
  `planner` slug is rebuilt as a new-engine-native persona* (description,
  procedure `planning`, the grove+task tool grant) replacing the extended
  bolt-on of earlier the same day; koala/delivery's delegation slugs are
  unchanged, so their handoffs land on the new persona. The ghost
  `procedure: 'thesis'` in the old record was also dead weight and did not
  survive the rebuild.