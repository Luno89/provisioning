# Plan: RED-GREEN the persona-pack chat route — tests named for BEHAVIOR

## What I just did wrong
- Drove the `chat-pack` router + `index.ts` mount as edits alongside tests rather than strict
  RED-first.
- Named a RED test "should serve the persona-pack chat router (mounted)" — describes the *process*
  (a mount), not a *behavior* a user cares about.
- Made a risky diff-edit to `routes.test.ts` (full bootstrap) that produced a subtle duplication.

## Fix: name tests by behavior, drive each slice RED-first

**The behavior we actually want to prove** (what a user/UI does):
1. A user can send a message to a persona pack over HTTP and stream back typed frames.
2. Unauthenticated callers are refused before the model is touched.

Those already exist untested correctly in `chat-pack.test.ts` — but they're named after the endpoint
structure. Rename them to behavior wording.

### Slice 1 — RENAME (no logic change)
- `chat-pack.test.ts`:
  - "enmits a {type:content} frame" → "returns an assistant's reply as a typed content frame"
  - "reject empty message" → "refuses an empty message before opening a stream"
  Commit.

### Slice 2 — the RED that guards the MOUNT, named as behavior
A test that an UNAUTHENTICATED `POST /api/chat-pack/koala` comes back **401**, which only happens if
the route actually exists at bootstrap. If the mount is missing, it's a 404.
- Name: "a chat request without a session is rejected, not routed"
- This is genuine RED: it FAILS currently? Let me verify. The mount IS in index.ts (committed
  `1e611698`). So this test PASSES already → it's a CHARACTERISATION of the real mount, not RED.
  → Treat it as a guard that stays green, not a RED we chase.

### Slice 3 — the real missing RED: behavior-first unit on persona resolution
- A test that `personaChatRouter`'s `resolvePersona` hook actually, for a **second**, non-koala
  persona pack, returns that persona's system prompt (proving "talk to ANY persona" not just
  Koala). Currently NOT covered, would fail without a new fixture's wiring. This is a genuine RED.
- Name: "serves a different persona's system prompt for a different pack"

### Slice 4 — split fat components only if needed
- `chat-pack.ts` router is single-file; it currently mixes: vault CRUD, model-call building,
  tool dispatch, context reset, persistence. Per the user's "break up the components if you
  need to": split so each behavioral slice is independently testable:
  - `lib/chat-pack/context.ts` — build transcript + reset policy (koala vault)
  - `lib/chat-pack/tools.ts` — the tool dispatcher (MCP-first, koala-chain)
  - `lib/chat-pack/model-call.ts` — build the provider request
  - `lib/chat-pack/bind-turn.ts` — orchestrates: transcript → model → round → persist
  Each gets its own RED tests; the router becomes a thin shell.

## Sequence (strict RED-GREEN each)
begin
1. Rename Slice-1 tests (behavior names) — keep green, commit.
2. Add Slice-2 characterization test (401 guard on mount) — should already be green; if it FAILS,
   that means I broke the mount, fix. Commit.
3. Slice-3 RED: add a `getPersonaPack('researcher')`-ish (or a second registered pack) and test that
   resolvePersona returns its systemPrompt → watch fail → add pack + wiring → green → commit.
4. Slice B: split chat-pack into the 4 submodules, each TDD'd: move koala vault/tool/model logic,
   port the router to the thin shell, run FULL backend suite + wire test to confirm no regression.
end.

## What I will NOT do
- No test edits that mutate unrelated tests or the boot test sloppily.
- No "is it mounted?" process-named tests — behavior names only.
- No deleting the legacy chat-wire tests / tied legacy routes while the frontend still uses them.