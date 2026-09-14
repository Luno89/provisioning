import type { EnvironmentHandle, ExecRequest } from '@koala/engine-core';

export type ApprovalDecision = 'allow' | 'allow-for-run' | 'deny';

export interface ApprovalAsk {
  handle: EnvironmentHandle;
  request: ExecRequest;
  runId: string;
  agentSlug: string;
}

export type ApprovalDecider = (ask: ApprovalAsk) => Promise<ApprovalDecision>;

export interface ApprovalVerdict {
  allowed: boolean;
  reason?: string | undefined;
}

export interface ApprovalGate {
  guard(ask: ApprovalAsk): Promise<ApprovalVerdict>;
  standingApprovals(): string[];
}

export interface ApprovalGateOptions {
  decide: ApprovalDecider;
  onAsk?: ((ask: ApprovalAsk) => void) | undefined;
}

const standingKey = (ask: ApprovalAsk): string => `${ask.runId}|${ask.handle.id}`;

export function createApprovalGate(options: ApprovalGateOptions): ApprovalGate {
  const standing = new Set<string>();

  return {
    async guard(ask: ApprovalAsk): Promise<ApprovalVerdict> {
      if (ask.handle.approval === 'none') return { allowed: true };
      if (standing.has(standingKey(ask))) return { allowed: true };

      options.onAsk?.(ask);
      const decision = await options.decide(ask);

      if (decision === 'deny') {
        return { allowed: false, reason: 'You declined to run that command.' };
      }

      if (decision === 'allow-for-run') standing.add(standingKey(ask));
      return { allowed: true };
    },

    standingApprovals(): string[] {
      return [...standing];
    },
  };
}

export function denyAll(): ApprovalGate {
  return createApprovalGate({ decide: async () => 'deny' });
}

export function allowAll(): ApprovalGate {
  return createApprovalGate({ decide: async () => 'allow' });
}
