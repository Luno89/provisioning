# Everything that shapes a model call, reconciled onto the persona-pack

Audit of every side effect on a model call that does not come from a pack, and the field that
should own it. One line each. Unchecked = still hardcoded.

## Target shape

```ts
interface PersonaPack {
  id; ownerId?; builtIn?; slug; name; description?;
  personaId;                 // WHO — prompt + identity
  basedOn?;                  // pack inheritance

  tools: string[];           // grants, by registry name
  mcp?: string[];            // sandbox MCP grants (NetworkPolicy is written before the pod starts)
  workspace?: WorkspaceScope;// image, cpu, memory, env, repo, egress, run{}

  // NEW — the fields this audit says are missing
  sampling?: TurnSampling;   // §1  per-turn-kind sampler defaults, not a hidden base layer
  budget?: PackBudget;       // §2 §5 §6  tokens, rounds, trimming
  prompt?: PromptComposition;// §3 §4  which sections, and the pressure thresholds that reshape them
  behaviour?: PackBehaviour; // §10 plan mode, extraction, classifier
  model?: PackModel;         // §9  explicit engine, no providers[0] fallback

  overrides: Overrides;      // every registered tunable, layered by resolveConfig
}
```

## §1 Sampling — a base layer the pack silently sits on

- [x] `toolTurnSampling` temperature 0.3 → `pack.sampling.toolTurn.temperature`
- [x] `PORTABLE_LOOP_GUARD` frequency_penalty 0.4 / presence_penalty 0.3 → `pack.sampling.conversation`
- [x] `TABBY_LOOP_GUARD` dry_multiplier 0.8 / dry_base 1.75 / dry_allowed_length 2 → `pack.sampling.byEngine.tabbyapi`
- [x] turn-kind switch `tool-turn` vs conversation → the pack declares both; the caller names the kind, never the values. `buildModelRequest` takes `sampling`; absent means send none, so there is no base layer left. A caller with no pack (a plain chat turn, the suite author, the probes) reads the shipped `koala` row via `defaultSampling(db)`. `TUNABLES` states no sampler default any more — the table describes a knob, the pack says what it is set to

## §2 Token ceilings

- [x] `TOOL_TURN_MAX_TOKENS = 800` (`sampling.ts:30`) → `pack.budget.replyTokens.tool`
- [x] `THINKING_TURN_MAX_TOKENS = 2000` (`sampling.ts:32`) → `pack.budget.replyTokens.thinking`
- [x] `FILE_TURN_MAX_TOKENS = 8000` (`sampling.ts:34`) → `pack.budget.replyTokens.writingFiles`
- [x] `maxTokens = 16000` default (`chat-pack-model-call.ts:34`) → `pack.budget.replyTokens.ceiling`
- [x] `PLAN_MODE_MAX_TOKENS = 8000` (`plan-mode.ts:86`) → `pack.budget.replyTokens.plan`
- [x] `FALLBACK_CONTEXT_TOKENS = 32_768` (`sampling.ts:41`) → read from the model endpoint; `pack.budget.contextTokens` only as an override
- [x] `CONTEXT_MARGIN_TOKENS = 512` (`sampling.ts:43`) → `pack.budget.contextMargin`
- [x] `MIN_TURN_TOKENS = 600` (`sampling.ts:45`) → `pack.budget.minReplyTokens`

## §3 Prompt sections injected around the pack's prompt

- [ ] Administrator status block (`persona-prompt.ts:34`) → `pack.prompt.sections.role`
- [ ] Escalation-active block (`persona-prompt.ts:42`) → `pack.prompt.sections.role`
- [ ] Standard-tenant-boundaries block (`persona-prompt.ts:48`) → `pack.prompt.sections.role`
- [ ] Secrets runtime model block (`persona-prompt.ts:56`) → `pack.prompt.sections.secrets`
- [ ] Active tools & workflow guidance (`persona-prompt.ts:114`) → `pack.prompt.sections.toolGuidance`
- [ ] "No services are deployed yet" (`persona-prompt.ts:119`) → `pack.prompt.sections.services`
- [ ] Services-you-can-hook-up listing (`persona-prompt.ts:125`) → `pack.prompt.sections.services`
- [ ] Recalled memories block (`persona-prompt.ts:130`) → `pack.prompt.sections.memories`
- [ ] Context-pressure notice (`persona-prompt.ts:138`) → `pack.prompt.sections.pressureNotice`
- [ ] `TOOL_DISCIPLINE_PROMPT` injected by the planner (`sampling.ts:58` → `planning-turn.ts:99`) → `pack.prompt.sections.toolDiscipline`

## §4 Prompt shape switched by context pressure

- [ ] 0.50 → one-phrase tool guidance (`persona-prompt.ts:100`) → `pack.prompt.pressure.minimalAt`
- [ ] 0.40 → one-line tool guidance (`persona-prompt.ts:107`) → `pack.prompt.pressure.compactAt`
- [ ] 0.48 → append the pressure notice (`persona-prompt.ts:137`) → `pack.prompt.pressure.noticeAt`

## §5 Loop budgets

- [x] `MAX_TOOL_ROUNDS = 8` (`leaf-tools.ts:5`) → `pack.budget.rounds`
- [x] `maxRounds = 12` default (`chat-runtime.ts`) → `pack.budget.rounds`. **The two collapsed to 8**, which is what `MAX_TOOL_ROUNDS` was and what the harness config panel already advertised; `/api/chat-pack` turns therefore take 8 rounds where they took 12
- [x] `MAX_TOOL_CALLS = 6` per round (`round-loop.ts:148`) → `pack.budget.callsPerRound`
- [x] `MAX_TOOL_ARGS = 400` (`round-loop.ts:149`) → `pack.budget.toolArgChars`
- [x] `MAX_TOOL_DIGEST = 2000` (`round-loop.ts:150`) → `pack.budget.toolResultChars`
- [x] `MAX_PROPOSALS_PER_REPLY = 8` (`plan-mode.ts:88`) → `pack.behaviour.planMode.maxProposals`

## §6 Trimming — what the model is actually shown

- [x] `KOALA_CONTEXT_PRESSURE = 0.55` (`koala-context.ts:4`) → `pack.budget.handoffAt`
- [x] `KOALA_HANDOFF_TAIL = 4` (`koala-context.ts:6`) → `pack.budget.handoffTail`
- [x] `MAX_GOAL_CHARS` / `MAX_DISCOVERY_CHARS` / `MAX_DISCOVERIES` / `MAX_LISTED_PROPOSALS` (`koala-context.ts:8-11`) → `pack.budget.handoff{...}`
- [x] `CONVERSATION_CHAR_BUDGET = 60_000` (`sandbox-tools.ts`) → `pack.budget.conversationChars`
- [x] `MAX_TOOL_RESULT_CHARS = 8_000` → `pack.budget.toolResultChars`. NOT the same knob as `MAX_TOOL_DIGEST` after all: this one clamps what the model is SHOWN, the digest clamps what is written to a frame. They live in `budget.toolResultChars` and `budget.record.digestChars`
- [x] `MAX_AGENT_STEPS = 200` (`sandbox-tools.ts:4`) → `pack.workspace.run.maxSteps` (exists; the CEILING is what is hardcoded)
- [x] `MAX_AGENT_TOKENS = 1_000_000` (`sandbox-tools.ts:6`) → `pack.budget.runTokens`
- [x] `WRAPUP_STEPS = 4` (`sandbox-tools.ts:10`) → `pack.workspace.run.wrapUpSteps`
- [x] `DEFAULT_CONVERSATION_GROWTH = 2` (`sandbox-tools.ts`) → already a tunable; make the pack the layer that sets it
- [x] `MAX_CONVERSATION_MESSAGE = 6000` (`agent-loop.ts:69`) → `pack.budget.messageChars`
- [x] `MAX_TRACE_REASONING/CONTENT/TOOL_RESULT/TOOL_ARGS` (`agent-loop.ts:64-67`) → `pack.budget.trace{...}` (record shape, not model input — lowest priority)

## §7 Tool metadata split across four tables

- [x] `KOALA_TOOL_EFFECTS` / `LEAF_TOOL_EFFECTS` → `effect` column on the registry row; both tables deleted
- [x] duplicated `parameters` on registry rows deleted — they had drifted from the arrays on 26 of 49 tools
- [x] `KOALA_TOOLS` / `LEAF_TOOLS` / `SANDBOX_TOOLS` deleted; every schema a model is offered is a row, read on the `surfaces` it declares. Descriptions were taken from the arrays, not the catalogue's own wording — they had drifted on 29 of 44 tools and the array text is what the model actually received. The three tools described differently per surface on purpose reconcile to one wording each; per-pack `description` (§3) is what would restore the split
- [x] six tools the agent loop dispatches (`run_tests`, `inspect_git_diff`, `test_http_endpoint`, `run_linter_audit`, `query_in_memory_db`, `save_harness_memory`) had handlers but no schema, so they were never callable; they now carry the parameters their handlers read
- [x] `WORKSPACE_IMAGES` and `PACKAGE_ACCESS` deleted; the four images are seeded rows read through `WorkspaceImageService`. `describeSandbox`, `buildAgentPrompt`, `personaWorkspace`, `validateTreeType` and `planSystemPrompt` all take rows
- [x] handler tables stay in code, keyed by name; `effectOf()` is the one lookup
- [x] `ALL_TOOL_SEEDS` is the single seeded catalogue; `tool-catalogue.test.ts` pins one parameter SHAPE per tool and one copy of `parameters`

## §8 Environment variables

- [ ] `WORKSPACE_KUBECONFIG` (7 sites) → `project.targetClusterId` → cluster kubeconfig; delete the variable
- [ ] `MANAGEMENT_KUBECONFIG` → platform infrastructure, stays an env var, not a pack concern
- [ ] `KOALA_DEBUG_RAW` → developer switch, stays
- [ ] `VLLM_DEVICE` / `HF_TOKEN` → deployment config for the engine, not how a model is called

## §9 Model selection

- [ ] `routeProvider` returns `providers[0]` when nothing is named (`model-registry.ts:167`) → `pack.model.endpointId`; no endpoint and no request model is an error, not a silent pick
- [ ] `provider.kind` decides which sampler set applies (`model-request.ts:27`) → keep, but the pack declares per-engine values (§1)

## §10 Behaviour that lives in a route rather than a record

- [ ] plan mode on/off, `PLAN_SYSTEM_PROMPT`, `AMBIENT_PROPOSAL_PROMPT` (`plan-mode.ts`) → `pack.behaviour.planMode`
- [ ] ambient extraction + its SEPARATE extractor model + `EXTRACTION_SYSTEM_PROMPT` (`extraction.ts`, `chat.ts:73`) → `pack.behaviour.extraction`
- [ ] thinking classifier / `predictFailure` / `updateModelProfile` (`thinking-classifier.ts`) → `pack.behaviour.classifier`
- [ ] smart token controller (`smart-token-controller.ts`) → `pack.budget`, once §2 exists

## Order

1. §7 — one tool registry; unblocks describing a tool once
2. §2 + §5 + §6 — `pack.budget`; the knobs that change output most
3. §1 — `pack.sampling`; needs §2's shape settled first
4. §3 + §4 — `pack.prompt`; largest surface, least risk
5. §9 — explicit model, then §8's cluster work
6. §10 — `pack.behaviour`; depends on branch chat becoming UI over the one engine

## Rule

A knob reaches the model through `resolveConfig` or it does not reach the model. Anything still
read directly from a module constant at call time is a bug, not a default.
