const SHA256 = /^[0-9a-f]{64}$/;
const REASON_LIMIT = 1000;
const BUSY_LIMIT = 10;

export type ReportedUpdateState = 'waiting' | 'updating' | 'failed' | 'not-a-service';

export type AgentUpdateState = 'current' | 'behind' | ReportedUpdateState | 'too-old';

export interface AgentUpdateReport {
  state: ReportedUpdateState;
  bundle: string;
  reason?: string | undefined;
  busyWith?: string[] | undefined;
  at: string;
}

export interface AgentUpdateView {
  state: AgentUpdateState;
  current: string;
  running?: string | undefined;
  reason?: string | undefined;
  busyWith?: string[] | undefined;
  at?: string | undefined;
}

export interface AgentUpdateFacts {
  lastSeenAt?: string | undefined;
  agentBundle?: string | undefined;
  agentUpdate?: AgentUpdateReport | undefined;
}

const REPORTED: readonly ReportedUpdateState[] = ['waiting', 'updating', 'failed', 'not-a-service'];

export function bundleOf(raw: unknown): string | undefined {
  return typeof raw === 'string' && SHA256.test(raw) ? raw : undefined;
}

export function reportedBundle(auth: unknown): string | undefined {
  return bundleOf(auth && typeof auth === 'object' ? (auth as { bundle?: unknown }).bundle : undefined);
}

export function agentUpdateReportFrom(raw: unknown, at: string): AgentUpdateReport | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as Record<string, unknown>;
  const state = REPORTED.find((known) => known === candidate.state);
  const bundle = bundleOf(candidate.bundle);
  if (!state || !bundle) return undefined;
  const reason = typeof candidate.reason === 'string' && candidate.reason.trim() ? candidate.reason.trim().slice(0, REASON_LIMIT) : undefined;
  const busyWith = Array.isArray(candidate.busyWith)
    ? candidate.busyWith.flatMap((entry) => (typeof entry === 'string' && entry.trim() ? [entry.trim().slice(0, 120)] : [])).slice(0, BUSY_LIMIT)
    : [];
  return {
    state,
    bundle,
    ...(state === 'failed' ? { reason: reason ?? 'it did not say why' } : {}),
    ...(state === 'waiting' && busyWith.length ? { busyWith } : {}),
    at,
  };
}

export function agentUpdateView(facts: AgentUpdateFacts, current: string | undefined): AgentUpdateView | undefined {
  if (!current) return undefined;
  const running = facts.agentBundle;
  if (!running) return facts.lastSeenAt ? { state: 'too-old', current } : undefined;
  if (running === current) return { state: 'current', current, running };
  const report = facts.agentUpdate;
  if (report?.bundle === current) {
    return {
      state: report.state, current, running, at: report.at,
      ...(report.reason ? { reason: report.reason } : {}),
      ...(report.busyWith?.length ? { busyWith: report.busyWith } : {}),
    };
  }
  return { state: 'behind', current, running };
}
