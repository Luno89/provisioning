import { createContext, useMemo, useState } from 'react';
import type {
  AgentRequest, AgentStep, ConversationMessage, EffectiveKnob, Experiment as ExperimentDetail, ExperimentSummary, ExperimentTask,
  HarnessConfig, HarnessProfile, PackChange, PromotionStanding, ResultSummary, RunSummary, TaskFile,
  Tunable, VariantResult,
} from '@koala/harness-types';

export type {
  AgentRequest, AgentStep, ConversationMessage, EffectiveKnob, ExperimentDetail, ExperimentSummary, ExperimentTask,
  HarnessConfig, HarnessProfile, PackChange, PromotionStanding, ResultSummary, RunSummary, TaskFile,
  Tunable, VariantResult,
};

export type Experiment = ExperimentSummary;

export { useExperimentDetail } from '../../hooks/use-experiment-detail';

export const card = 'bg-[var(--bark-800)] border border-[var(--bark-600)] rounded-xl';

export const median = (ns: number[]) => {
  const s = [...ns].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

export interface Tally {
  runs: number; verified: number; claimed: number; errored: number;
  attempted: number;
  steps: number; tokens: number; ms: number;
}

const isBroken = (r: ResultSummary): boolean =>
  Boolean(r.error) || (r.steps === 0 && r.tokensUsed === 0);

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

export const GROUP_LABEL: Record<string, string> = {
  sampling: 'Sampling',
  loop: 'Loop',
  prompt: 'Prompt',
};

export const describeValue = (v: unknown) => (v === undefined ? 'default' : String(v));

export const tasksOf = (e: ExperimentDetail): ExperimentTask[] => e.tasks ?? [];

export const errorMessage = (err: unknown): string => {
  const e = err as { response?: { data?: { error?: string } }; message?: string };
  return e?.response?.data?.error ?? e?.message ?? 'Something went wrong.';
};

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
  if (t.engine) lines.push(`Only sent to ${t.engine}; dropped on any other engine.`);
  if (t.placement === 'loop') lines.push('Read by the agent loop — never sent to the model.');

  lines.push(`Set in ${t.source}`);
  return lines.join('\n');
}

export type Language = 'shell' | 'js' | 'json' | 'text';

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
  origin?: string;
  onChange: (value: string) => void;
}

export const EditorSlot = createContext<{
  openId: string | null;
  open: (req: EditRequest) => void;
  close: () => void;
} | null>(null);

export function useEditorSlot() {
  const [request, setRequest] = useState<EditRequest | null>(null);

  const slot = useMemo(() => ({
    openId: request?.id ?? null,
    open: (req: EditRequest) => setRequest(() => req),
    close: () => setRequest(null),
  }), [request]);

  return { slot, request };
}

/**
 * A knob grid as a pack edit. Mirrors the backend's `editFromKnobs`: each tunable names the pack
 * field it sets, so the Lab writes pack values rather than a bag layered over one.
 *
 * ── DUPLICATED, KNOWINGLY ──
 * apps/backend/src/lib/derived-packs.ts owns this. It is repeated here because the editor has to
 * show what it will write before it sends anything, and the paths come from the same `Tunable.path`
 * the backend reads. If the two disagree, the backend wins — it is what actually saves.
 */
export function packEditFromKnobs(
  knobs: Record<string, unknown>,
  tunables: readonly { key: string; path?: string }[],
): Record<string, unknown> {
  const edit: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(knobs)) {
    const path = tunables.find((t) => t.key === key)?.path;
    if (!path || value === undefined) continue;

    const parts = path.split('.');
    let at = edit;
    for (const part of parts.slice(0, -1)) {
      at[part] ??= {};
      at = at[part] as Record<string, unknown>;
    }
    at[parts[parts.length - 1]!] = value;
  }
  return edit;
}

/** Reads a dotted `Tunable.path` out of a pack, so a knob can show what the pack has it set to. */
export const packValueAt = (pack: unknown, path: string | undefined): unknown =>
  (path ? path.split('.').reduce<unknown>(
    (at, key) => (at && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined),
    pack,
  ) : undefined);
