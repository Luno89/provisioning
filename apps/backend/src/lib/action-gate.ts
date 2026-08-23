/**
 * Layer 2 of the four safety layers — may this agent take this action, right now?
 *
 * ── WHERE THIS SITS ──
 * Layer 3 is the sandbox, and it is strong: read-only root filesystem, `automountServiceAccountToken:
 * false`, default-deny egress with holes opened only for resolved bindings. Anything a leaf runs as
 * a COMMAND is already answered there.
 *
 * What that boundary never sees is an in-process tool call. `runKoalaTool` and `runLeafTool`
 * dispatch inside the backend, holding the backend's own database handle and the caller's identity.
 * A tool is therefore the one action in the system with no enclosing wall, which is why it gets one
 * here rather than a second, weaker copy of the sandbox — a regex approximating a NetworkPolicy is
 * worse than no regex at all.
 *
 * ── DEFAULT DENY, AND WHY THAT WORD MATTERS ──
 * The abandoned harness-v2 gate returned "allowed" for an action it did not recognise. That reads as
 * caution and is the opposite: it protects against the calls someone already enumerated, and waves
 * through every one they did not. What it waved through was `call_platform_api` — any HTTP method,
 * any path, with the caller's session cookie.
 *
 * An undeclared tool here is refused. The cost is that adding a tool means answering what it does;
 * the benefit is that forgetting to is a failing test rather than an incident.
 *
 * ── WHAT THIS DOES NOT OWN ──
 * `validateArgs` already draws the line this must respect: the HANDLER owns whether a call makes
 * sense, because it knows what its fields are for and says so far better than anything generic. The
 * gate owns only whether the call may run AT ALL. It must not grow argument rules — that is how a
 * gate becomes a duplicate of the handlers, drifts from them, and starts refusing valid work.
 */

/**
 * Three categories, chosen because they are the three answers a caller actually needs.
 *
 * `read` observes and changes nothing — logs, events, a corpus search, a web page. Safe to hand to a
 * context that should not be able to act, which is the case that makes the distinction earn its
 * keep: a shared conversation, a replay, an evaluation run.
 *
 * `write` changes stored state that somebody will later rely on — a project record, a dependency, a
 * leaf's memory.
 *
 * `propose` creates something that does not take effect until a later step accepts it. Kept apart
 * from `write` because a proposal is how the harness is MEANT to make changes: it is reviewable, and
 * a context can reasonably allow proposing while refusing direct writes.
 */
export type ToolEffect = 'read' | 'write' | 'propose';

/** The full set, and the only values a declaration may take. Anything else fails closed. */
export const ALL_EFFECTS: readonly ToolEffect[] = ['read', 'write', 'propose'] as const;

/** A context that may look at anything and change nothing. */
export const READ_ONLY: readonly ToolEffect[] = ['read'] as const;

/** A context that may look and suggest, but not commit. */
export const PROPOSE_ONLY: readonly ToolEffect[] = ['read', 'propose'] as const;

export type GateDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * The whole gate.
 *
 * `effect` is the tool's DECLARATION, looked up by the caller; `permitted` is what this context
 * allows. Both have to be present and agree. The refusal is a sentence rather than a boolean
 * because it is handed to a model, and a model given `false` retries the same call — the same
 * reasoning as `renderSearchOutcome` distinguishing "no results" from "search is down".
 */
export function gate(
  name: string,
  effect: ToolEffect | undefined,
  permitted: readonly ToolEffect[],
): GateDecision {
  if (!effect || !ALL_EFFECTS.includes(effect)) {
    return {
      allowed: false,
      reason:
        `"${name}" cannot run: it declares no effect, or declares one that is not `
        + `${ALL_EFFECTS.join(', ')}. This is a defect in the tool, not in your call — `
        + `report it and use a different tool.`,
    };
  }

  if (!permitted.includes(effect)) {
    return {
      allowed: false,
      reason:
        `"${name}" ${effect}s, and this conversation is limited to `
        + `${permitted.length ? permitted.join(' and ') : 'nothing'}. Nothing was changed. `
        + (permitted.includes('propose')
          ? 'Propose the change instead, and it will be applied once accepted.'
          : 'Describe what you would do and let the person decide.'),
    };
  }

  return { allowed: true };
}
