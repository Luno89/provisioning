/**
 * The pieces every Lab panel needs.
 *
 * Split out when the Lab became two tabs and a card tab strip: eight panels each importing the
 * card class and the detail query from a sibling would make the sibling the de-facto root, which
 * is how a 1,500-line file happens twice.
 */
import { createContext, useMemo, useState } from 'react';
import type {
  AgentRequest, AgentStep, ConversationMessage, EffectiveKnob, Experiment as ExperimentDetail, ExperimentSummary, ExperimentTask,
  HarnessConfig, HarnessProfile, OverrideChange, PromotionStanding, ResultSummary, RunSummary, TaskFile,
  Tunable, VariantResult,
} from '@koala/harness-types';


export type {
  AgentRequest, AgentStep, ConversationMessage, EffectiveKnob, ExperimentDetail, ExperimentSummary, ExperimentTask,
  HarnessConfig, HarnessProfile, OverrideChange, PromotionStanding, ResultSummary, RunSummary, TaskFile,
  Tunable, VariantResult,
};

/** The list row. Scores, no evidence — see the shared types for why. */
export type Experiment = ExperimentSummary;

/**
 * Re-exported, not re-declared.
 *
 * This hook USED to live here, and that was the wrong home: `shared.ts` is what eight panels
 * import for the card class and the median helper, so a data-fetching hook here meant every panel
 * that wanted a CSS string also pulled in axios. It lives in `api/harness/experiments.ts` now,
 * beside the other experiment calls, with its docblocks intact — the `enabled` gate and the
 * poll-while-running rule are both measured behaviour, not preference.
 *
 * Still exported from here because eight files import it from `./shared`, and pointing them all
 * at the api module is a separate, mechanical change.
 */
export { useExperimentDetail } from '../../hooks/use-experiment-detail';

export const card = 'bg-[var(--bark-800)] border border-[var(--bark-600)] rounded-xl';

export const median = (ns: number[]) => {
  const s = [...ns].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

export interface Tally {
  runs: number; verified: number; claimed: number; errored: number;
  /** Runs that got a fair attempt — the denominator every rate here is shown over. */
  attempted: number;
  steps: number; tokens: number; ms: number;
}

/**
 * A run that never got a fair attempt.
 *
 * ── DUPLICATED, KNOWINGLY ──
 * This mirrors `classifyOutcome`'s `broken` case in `apps/backend/src/lib/run-outcome.ts`, which is
 * the source of truth. It cannot be imported: the shared package is types-only by design, and that
 * constraint is what keeps it free of a build step. So the rule lives in two places and they can
 * drift — if this ever disagrees with the backend, the backend is right.
 *
 * Zero steps AND zero tokens means no turn ever completed. A genuine attempt that failed instantly
 * still spends a turn, so a fast wrong answer cannot land here.
 */
const isBroken = (r: ResultSummary): boolean =>
  Boolean(r.error) || (r.steps === 0 && r.tokensUsed === 0);

/**
 * One cell's worth of arithmetic.
 *
 * Runs that errored are counted but kept out of the medians — they recorded zeros because nothing
 * ran, and averaging those in makes a variant look cheaper for having failed to start.
 */
// Typed to the SUMMARY, which is the narrower shape — so it accepts both a polled list row and a
// full record without either side needing to know which it has.
export const tally = (runs: ResultSummary[]): Tally => {
  const measured = runs.filter((r) => !r.error);
  const fair = runs.filter((r) => !isBroken(r));
  return {
    runs: runs.length,
    verified: runs.filter((r) => r.verified).length,
    claimed: runs.filter((r) => r.succeeded).length,
    errored: runs.length - measured.length,
    attempted: fair.length,
    steps: median(measured.map((r) => r.steps)),
    tokens: median(measured.map((r) => r.tokensUsed)),
    ms: median(measured.map((r) => r.durationMs)),
  };
};

/**
 * Results: the suite total, then the task-by-variant breakdown.
 *
 * The two halves answer different questions and the second is the one worth the GPU time. The
 * headline says which variant passed more of the suite; the matrix says WHICH tasks it passed, and
 * two variants tied on the headline can disagree on every row underneath — a real finding about
 * what the setting does that no single aggregate can show.
 *
 * `verified` leads and `claimed` sits beside it throughout, because the interesting outcome is when
 * they disagree — that is a run the agent called a success on work that never happened.
 */

/** Group headings for the registry's `group` field. */
export const GROUP_LABEL: Record<string, string> = {
  sampling: 'Sampling',
  loop: 'Loop',
  prompt: 'Prompt',
};

export const describeValue = (v: unknown) => (v === undefined ? 'default' : String(v));

/**
 * The suite as the server sends it.
 *
 * Both the list and the detail route normalise the pre-suite shape, so there is nothing to resolve
 * here and no synthetic task id for the client to know about.
 */
export const tasksOf = (e: ExperimentDetail): ExperimentTask[] => e.tasks ?? [];

/** Axios rejects with a shaped error; this reads the server's message without reaching for `any`. */
export const errorMessage = (err: unknown): string => {
  const e = err as { response?: { data?: { error?: string } }; message?: string };
  return e?.response?.data?.error ?? e?.message ?? 'Something went wrong.';
};

/**
 * The hover description for one knob.
 *
 * ── ONE BUILDER, EVERY SURFACE ──
 * The axis picker, the variant editor and the focus options table each show the same knobs, and
 * each had its own idea of what to put in a tooltip — so the same setting explained itself three
 * different ways depending on where you met it. This is the one description, and it is assembled
 * from the registry rather than written per surface.
 *
 * Ordered by what you want first: what it does, then what it is set to and why, then the bounds,
 * then where to change it. A tooltip whose first line is a file path has buried the answer.
 */
export function describeTunable(
  t: Tunable,
  live?: { value: unknown; source: 'harness' | 'adopted' } | undefined,
): string {
  const lines: string[] = [t.label];
  if (t.note) lines.push('', t.note);

  const effective = live ? live.value : t.default;
  lines.push('', effective === undefined
    ? 'Currently unset — the engine\'s own default applies.'
    : `Currently ${String(effective)}${live?.source === 'adopted' ? ' (adopted default, not the built-in)' : ''}`);

  if (t.min !== undefined || t.max !== undefined) {
    lines.push(`Range ${t.min ?? '−∞'} to ${t.max ?? '∞'}${t.step ? `, step ${t.step}` : ''}`);
  }
  // Worth saying on the knob itself: it is accepted, stored, and then silently dropped elsewhere.
  if (t.engine) lines.push(`Only sent to ${t.engine}; dropped on any other engine.`);
  if (t.placement === 'loop') lines.push('Read by the agent loop — never sent to the model.');

  lines.push(`Set in ${t.source}`);
  return lines.join('\n');
}

/* ── the editor slot ───────────────────────────────────────────────────────────────────────────
 * A view with somewhere sensible to put a full editor claims it by calling `useEditorSlot` and
 * rendering the request it hands back; fields find it through the context. Lives here rather than
 * beside the editor so the editor file exports only components.
 */

export type Language = 'shell' | 'js' | 'json' | 'text';

/** Guesses from a filename or field name. Wrong guesses cost colour, never correctness. */
export function languageFor(hint: string): Language {
  const h = hint.toLowerCase();
  if (/\.json$/.test(h)) return 'json';
  if (/\.(js|mjs|cjs|ts|tsx)$/.test(h)) return 'js';
  if (h.includes('verify') || h.includes('command')) return 'shell';
  return 'text';
}

export interface EditRequest {
  id: string;
  label: string;
  value: string;
  language: Language;
  /** Where `value` came from, when it was inherited rather than set on the thing being edited. */
  origin?: string;
  onChange: (value: string) => void;
}

export const EditorSlot = createContext<{
  openId: string | null;
  open: (req: EditRequest) => void;
  close: () => void;
} | null>(null);

/**
 * Owns whichever field is currently open.
 *
 * ── THE HANDLER MUST SURVIVE THE FIELD ──
 * The request carries the field's `onChange`, captured when the editor opened. That handler often
 * outlives the field that supplied it — in Focus the editor replaces the left pane, so those inputs
 * are not merely re-rendered but unmounted — and the state it writes moves on meanwhile, since
 * Koala can revise the same task from the right pane while you type.
 *
 * So the rule for anything passed here: update state functionally. A handler built on a value read
 * during render commits onto a snapshot taken when the editor opened, silently reverting everything
 * changed since. Refreshing the captured closure cannot fix it — the field is gone by then.
 */
export function useEditorSlot() {
  const [request, setRequest] = useState<EditRequest | null>(null);

  const slot = useMemo(() => ({
    openId: request?.id ?? null,
    // Wrapped, because useState calls a bare function argument as an updater and this one is an
    // object holding a handler.
    open: (req: EditRequest) => setRequest(() => req),
    close: () => setRequest(null),
  }), [request]);

  return { slot, request };
}
