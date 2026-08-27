# Plan: Consolidate the Koala and Chat Tool Round-Loops

**Branch:** `refactor/koala-chat-round-loop`
**Status:** plan only — no execution

---

## What this is

`routes/koala.ts` (692 lines, ~460-line chat handler) and `routes/chat.ts` (1067 lines) each carry
a private copy of the same machine: a streaming tool round-loop over `/chat/completions`. The
koala.ts docblock says the consolidation is "a SEPARATE, later change, and `koala.test.ts` exists
to make that one safe." This plan is that change.

## What the two loops share (extract)

| Concern | koala.ts | chat.ts |
|---|---|---|
| Round budget | `KOALA_TOOL_ROUNDS = 12` | `MAX_TOOL_ROUNDS` |
| SSE framing | `openSse`/`sendFrame`/`endSse` | same |
| Stream scanning | `ToolCallScanner` + hand-rolled `data:` line parser (`drain`) | `ToolCallScanner` + `pump` + 4 more scanners |
| Token fitting per round | `fittedMaxTokens(KOALA_MAX_TOKENS, promptChars)` | `fittedMaxTokens(strategy.maxTokens, ...)` |
| Over-window refusal | pre-flight check with reader-facing error | none (fixed later, comment says "the chat route never was") |
| Per-round thread trim | `trimConversation(turn)` each round | not per-round |
| Remote MCP routing | `routeCall` first, then own tools | `chatMcp.call` first, then `runLeafTool` |
| Exhausted-rounds wrap-up | forced `tool_choice:'none'` final round | forced final round + `interruptedReason` frame |
| Persist-after-stream | re-fetch conversation, append | re-fetch branch, `saveBranch` full replace |

## What differs (parameterise, do not unify)

1. **Wire envelope** — koala re-encodes as `{delta}/{reasoning}/{toolCall}/{toolResult}`;
   chat forwards provider frames verbatim via `forwardChunk`. Pinned on both sides by
   `routes/chat-wire.test.ts`. → The shared loop takes an `emit` callback; each router keeps its
   own emitter.
2. **Tool executor** — koala: own handlers + lazy enable + proposal capture; chat: leaf tools +
   proposal settle + extraction. → A `executeTool(call, round) => { content, ...effects }` callback.
3. **Context policy** — koala: handoff artifact + 0.55 pressure; chat: `buildOutboundMessages`.
   → Caller assembles `messages` before the loop; loop owns per-round trim only.
4. **Persistence** — conversation vs branch, different shapes. → `persist(result)` callback.
5. **Chat-only machinery** — smart token controller, thinking classifier, plan mode, persona
   assignment. NOT part of the shared loop. Chat keeps its outer orchestration.

## Target shape

```
apps/backend/src/lib/round-loop.ts
  export interface RoundLoopConfig {
    maxRounds: number
    maxTokens: (promptChars: number) => number
    call: (messages: unknown[], opts?: { toolChoice?: 'none' }) => Promise<Response>
    emit: (frame: Record<string, unknown>) => void      // wire envelope lives HERE, per caller
    executeTool: (call: ToolCall) => Promise<{ content: string; ... }>
    trimPerRound?: (messages: unknown[]) => unknown[]   // koala: trimConversation; chat: identity
    onExhausted: 'wrap-up' | 'interrupt-notice'
    promptChars: (messages: unknown[], toolNames: string[]) => number
  }
  export async function runToolRounds(cfg, initialMessages): Promise<RoundLoopResult>
    // { answer, spoken, thinking, toolCalls, exhaustedRounds, enabledNow?, proposals? }
```

Both routers shrink to: auth → context assembly → `runToolRounds` → persistence.

## TDD sequence (RED → GREEN per cycle, one vertical slice each)

Baseline first: full suite green on `main` (verified today: 416 + 2565).

- **C1 — Extract the stream parser.** RED: new `lib/round-loop.test.ts` feeding raw SSE bytes
  (incl. frame split mid-JSON, tool-call fragments by index — cases stolen from chat-wire tests)
  to a `parseStreamChunk` helper; watch fail. GREEN: lift the `data:` line parser + scanner out of
  koala's `drain`; koala consumes it; chat's `pump` refactored onto it. Wire tests must stay green.
- **C2 — Extract the round loop (koala first).** RED: drive `runToolRounds` with a fake `call`
  returning scripted rounds: content-only, tool-call→tool-result→answer, exhausted-budget. GREEN:
  koala's handler becomes config + callbacks. `chat-wire.test.ts` koala block is the acceptance gate.
- **C3 — Port chat.ts onto the loop.** RED: same fake-driven tests for chat's shape
  (`interruptedReason` on exhaustion). GREEN: chat's loop replaced; its four extra scanners stay
  chat-side, fed from the loop's chunk callback. This is the risky cycle — chat.ts is the most
  behaviour-sensitive route; keep each commit revertable.
- **C4 — Per-round trim as policy.** Move `trimConversation` behind `trimPerRound`; consider
  enabling it for chat (it currently lacks per-round trimming and has the documented 34,816/32,768
  refusal failure). Only if wire tests stay green untouched.
- **C5 — Cleanup.** Delete dead locals, hoist per-call `McpRegistryService` (koala.ts:569) to turn
  scope, re-run `scripts/alive.sh` after restarting dev workers.

## Non-goals

- No change to either wire envelope (chat-wire.test.ts is the contract).
- No unification of persistence; no new features (stop button, conversation-level get) — separate.
- No touching `agent-loop.ts` (leaf loop) — different enough that sharing would be force-fitting.

## Risks

- chat.ts's outer handler mixes loop concerns with plan-mode/extraction flow — C3 may reveal
  coupling that argues for a smaller extraction (parser only, C1 shipped alone still wins ~150
  lines and the frame-splitting correctness).
- tsx-watch hot reload during dev can write partial docs (seen today with clusterProviders) —
  don't run the dev stack mid-cycle.

## Definition of done

Both wire-format test files pass unmodified; total lines across the two routes drop by ≥300;
`npm run test:unit` and `scripts/alive.sh` green; every extracted function carries the docblocks'
measured numbers with it.
