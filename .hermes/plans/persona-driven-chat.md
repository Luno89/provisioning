# Plan: One chat engine, persona-driven — Koala as a persona, not an implementation

**Branch:** (new) `refactor/persona-driven-chat`
**Status:** plan only — no execution yet
**Depends on:** the round-loop consolidation already on `refactor/koala-chat-round-loop`
(committed). This plan is the personality layer on top of that shared engine.

---

## PART 1 — AUDIT: what exists today, and what it is used for

There are **two chat frontends**, **two chat routes**, **one sandboxed agent loop**, and a
**persona system** that is *partly* persona-parameterized. The line items:

### The model runtimes

| Runtime | File | Frontend | What it is | Wire format |
|---|---|---|---|---|
| Harness chat | `routes/chat.ts` (1067→) | `components/Chat.tsx` (979) | "the workbench's model conversation, with tools" — tied to branches/leaves/trees. Sends branch tooling, does plan-mode, extraction, persona-assignment, thinking-classifier | **Byte-for-byte passthrough** of the provider's own OpenAI SSE (`forwardChunk`) |
| Koala chat | `routes/koala.ts` (517) | `components/KoalaChat.tsx` (477) + `Koala.tsx` (114) | General "assistant you talk to when undecided". Owns `Conversation` CRUD/CRUD titles, reset/handoff context, propose-project/app-spec tools | Re-encodes as `{delta}/{reasoning}/{toolCall}/{toolResult}` |
| Sandbox agent | `lib/agent-loop.ts` (`runAgentLoop`) | leaf runner | Model → sandbox execution for leaves/workers. **Not** chat; asks for a `sandbox` and streams per-step not per-token | N/A (no chat UI) |

The two chat routes share the round-loop machine (now extracted into `lib/round-loop.ts`), but
deliberately speak **different wire envelopes** on purpose (`routes/chat-wire.test.ts` pins both).

### What Koala actually is today

- Koala is **already described as a persona**: seeded by `koalaSeed()`, looked up in `ensureKoala`
  by `isChatOnly(p)`, boosted with `KOALA_TEMPERATURE`, and resolved through `resolveConfig`
  (`profile → persona → request` chain shared with every persona).
- It's NOT in `persona-seeds.ts` (Framer, Researcher, Synthesist, Ingestor, Reviewer, Judge,
  Builder, ...). It's special-cased in `index.ts` via `ensureKoala`.

### The real gap (the user's point, stated precisely)

`routes/koala.ts` is a **conversation engine hard-wired to one persona** (the chat-only one).
Everything downstream of "pick the Koala persona" — the conversation vault, the tool envelope, the
proposal handling, the frontend component that binds to `/api/koala/chat` — is NOT parameterized
by persona. So:

- you can't talk to *another* persona as a chat conversation (a Researcher you want to chat to is
  still only a workbench/leaf persona, not a conversation)
- you can't swap the model or tools a chat uses without editing code or the Lab panel
- the "talk to the machine" experience is one hardcoded surface

`routes/chat.ts` IS the harness/model chat; `routes/koala.ts` IS the personal-chat persona. Two
implementations exist NOT because they should, but because the underlying engine never became
persona-driven.

---

## PART 2 — PROPOSED SHAPE: one engine, one surface, persona as the switch

**The principle:** chat is a *capability* (model ↔ conversation ↔ tools), a persona is a *choice of
what that capability is tuned for*. Koala = one seeded persona with a `tools` bag, a `wire`, a
`model`. The engine is shared; nobody hardcodes "this is Koala" past the seed.

```
components/ChatSurface.tsx  ──(persona name)→  /api/chat/:personaId/stream
                                                 │
                                   lib/chat-engine.ts  (may be persona A or B)
                                      │ round-loop (shared, done)
                                      │ conversation vault  (generic: id, messages, reset)
                                      │ context policy      (per persona)
                                      │ tool router          (per persona: koala-tools / leaf-tools)
                                      │ envelope adapter     (passthrough / re-encode)
                                 ▲                            ▲
      persona.ts fields:   wire: 'passthrough'|'reencode'   tools: 'koala'|'leaf'|'none'
                           model, overrides, systemPrompt     (all already tunable per persona)
```

### Key decisions to make explicit

1. **Persona owns the chat tuning.** Add to `Persona` two declarative knobs (defaulted, so nothing
   existing breaks): `tools: 'koala' | 'leaf' | 'none'` (which tool bag the conversation gets) and
   `wire: 'passthrough' | 'reencode'` (which SSE envelope surfaces). Model/thru overrides/
   temperature already resolve through `resolveConfig`; a persona can already route to a different
   model. That completes "swap models / any substructure" with no code.
2. **`/api/chat/:personaId` becomes the one chat endpoint**, and `/api/koala/chat` is kept only as
   an alias so the current frontend doesn't break mid-flight (routes/chat-wire.test.ts stays the
   contract).
3. **`lib/chat-engine.ts`** owns: conversations CRUD + reset/handoff context (in koala-chat today),
   the round loop (already shared), and a thin `envelope` adapter. `routes/koala.ts` + the chat
   half of `routes/chat.ts` become thin binders into it.
4. **The frontend respects one `ChatSurface`** driven by `personaId`; `Koala.tsx`/`KoalaChat.tsx`
   become the personas view / a persona-selected chat, not a separate chat implementation.

---

## PART 3 — PLAN (strict TDD, small slices)

Baseline on `main` + the merged round-loop helpers. No live dev stack mid-cycle.

- **P1 — Persona gets chat traits (defaulted).** RED: `personas.test.ts` fails for a persona that
  declares `tools`/`wire`; GREEN: add the optional fields + defaults to `Persona` and `resolveConfig`
  passes them through; REFACTOR: nothing downstream. Commit.
- **P2 — Extract conversation engine from koala.** RED: new `lib/chat-engine.test.ts` exercises
  a persona with `tools:'chat'` — create/list/delete conversation, reset, produce a turn via a fake
  model. GREEN: lift the koala-specific machinery (`Conversation` CRUD, title/handoff, propose
  tools) into `lib/chat-engine.ts`, with koala's current envelope as `wire:'reencode'`. koala route
  becomes `chatEngine.bind(router, koalaPersona)`. The `routes/chat-wire.test.ts` koala block stays green.
- **C3 — `/api/chat/:personaId` generic conversation.** RED: `chat-engine.test.ts` shows the engine
  serves a different persona (different `systemPrompt`, `wire:'passthrough'` used for a leaf-style
  persona) with no code change. GREEN: route fraction; keep `/api/koala/chat` as an alias to a
  `personaKoala` binding. Wire tests both pins still green.
- **C4 — One frontend surface.** `ChatSurface.tsx` renders whatever a persona's threaded conversation
  produces (toolCall pills, proposed cards, deltas, reasoning), given `personaId`. `KoalaChat.tsx`
  + the workbench/HarnessChat path use the same component. No per-persona chat component left.
- **C5 — seed Koala through the uniform persona registry.** RED: `persona-seeds.test.ts` wants Koala
  present as a normal seed (like Framer/B) with `tools:'chat', wire:'reencode', temperature`.
  GREEN: add it; delete the `ensureKoala`/`isChatOnly` special-casing in `index.ts`; the default chat
  in the surface resolves persona→Koala through the same name lookup all personas use. Live-verify a
  converation with a real backend + a swap of model.
- **C6 — polish.** Docs/readme section "one chat, persona-driven"; add a Lab knob to pick chat persona
  (already supported by prior tunables). Full `test:unit` + `scripts/alive.sh`.

## Connotations / risks

- **Wire parity is load-bearing.** `/api/chat` is a byte-for-byte passthrough; `/api/koala/chat`
  re-encodes. Both pinned by `chat-wire.test.ts`. The engine keeps BOTH paths and chooses by persona
  `wire`; do not unify the envelope (that would break both clients).
- **The harness/leaf loop is genuinely different** (`agent-loop.ts` needs sandbox + per-step hook).
  Do NOT force it into the chat engine; it stays for work-approval. The chat engine covers
  conversation-personas + branch/harness chat.
- **`Chat.tsx` (979) and `KoalaChat.tsx` (477) are the two creams surfaces** — merging to one
  `ChatSurface` is the riskiest frontend slice; do it AFTER backend kinds prove in tests, and keep
  each commit revertable.
- **Persona field additions** must default so existing seeded personas behave identically (no silent
  behavior change).

## Definition of done

- Adding a persona with `tools`/`wire`/`model` yields a working chat conversation with zero code
  change to routes/frontend. Koala is just one such persona in a list. All personas' model/overrides/
  tools tunable in Lab without restart. `chat-wire.test.ts` unmodified and green. `test:unit` green,
  `scripts/alive.sh` green, live conversation verified through the shared `ChatSurface` and a model
  swap (e.g. Koala → a different model) confirmed working for the server-reload path.