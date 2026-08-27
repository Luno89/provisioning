# Koala Chat Audit — thinking & interactive components "not working"

## Immediate cause (highest likelihood)
The dev stack is currently **not running**:
- `curl localhost:5173` and `localhost:3001` both return 000 (DOWN)
- No `concurrently` / `tsx watch` / `vite` process is alive
- So "none of the thinking or interactive components seem to work" may simply be
  "nothing renders because the app isn't running."

The reason the stack is down is the **dev script change** (see below) — `npm run dev`
now runs a new `ensure-infisical.sh` step whose failure aborts the whole `&&` chain
before any server starts (`set -euo pipefail` + `exit 1` when the k3d cluster isn't
reachable).

## Verdict needed first
1. Bring the stack up (fix or gate the infisical step) and confirm ChatSurface renders
   at `#/chat/koala`.
2. Only if it renders but thinking/proposals/pills are still absent should we audit the
   wire → reducer → component chain (below).

## Suspect chain to audit (if rendering but no interactivity)
- `chat-pack.ts` (route) → emits `UnifiedFrame` SSE
- `mapTurnToFrames` in `chat-runtime.ts` — delivery filter gates thinking/content/pills
  by `pack.delivery`. **Check `KOALA_PACK.delivery.thinking === true` and `tools === 'semantic'`.**
- `parse-sse.ts` (FE) — does it actually accumulate `{type:'thinking', delta}` frames?
- `chat-unified-reducer.ts` — does it map thinking frames to `liveThinking`?
- `ChatSurface.tsx` — renders `<details open>` only when `state.liveThinking` is set;
  tool pills render from `state.tools`.

## Big uncommitted rework to be aware of
There is a LARGE uncommitted changeset already on `main` (not from the earlier shipped
work): `InfisicalService`, `apps/backend/src/services/InfisicalService.ts`, a rewritten
`ChatSurface.tsx` + `components/Chat/` (ChatComposer, ChatHero, ChatMessageRow,
ChatToolCallCard), `CollapsibleHistoryList.tsx`, `PersonaConfigDrawer.tsx`,
`persona-prompt.ts`, `tool-seeds.ts`, new cdktf constructs (vllm, tabbyapi, etc.), and
mono infisical encryption files under `apps/backend/data/`. These are **uncommitted**.
Before auditing "thinking not rendering", confirm whether these are the user's intended
work-in-progress or stale leftovers — the rewrite may itself be the regression.

## Plan (ordered)
1. **Restore dev**: decide fate of `ensure-infisical.sh` in `dev` (keep + fix, or gate
   behind a flag). Get 5173/3001 back up. → unblocks everything.
2. **Repro**: open `#/chat/koala`, send a prompt, capture the raw SSE stream and the
   React state. Confirm whether thinking/pills appear.
3. **Wire audit**: assert frame shapes (content delta string; thinking delta; toolAnnounce
   payload wrapper) match the new ChatSurface reducer. Fix any mismatch.
4. **Pack audit**: confirm KOALA_PACK delivery flags; enable missing ones.
5. **Cleanup**: commit or quarantine the uncommitted rework so the audit runs against a
   known-good tree.