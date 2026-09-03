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

export {
  card, errorMessage, describeValue, describeTunable, packEditFromKnobs, packValueAt,
} from '../../lib/pack-editor.js';

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

export const tasksOf = (e: ExperimentDetail): ExperimentTask[] => e.tasks ?? [];

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
