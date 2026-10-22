export interface ApprovalRequest {
  callId: string;
  allowed: boolean;
  forRun?: boolean | undefined;
  conversation?: { id: string; tool: string } | undefined;
  auto?: 'agent' | 'tree' | undefined;
}

export type ApprovalOutcome = 'sent' | 'not-yours' | 'no-such-conversation' | { refused: string };

export class ApprovalService {
  constructor(private readonly deps: {
    store: {
      ownsRun(ownerId: string, runId: string): Promise<boolean>;
      runOrigin(ownerId: string, runId: string): Promise<{ agentId?: string | undefined; turnId: string } | undefined>;
      allowToolInConversation(ownerId: string, conversationId: string, tool: string): Promise<boolean>;
    };
    runs: { approve(runId: string, callId: string, allowed: boolean, forRun?: boolean): Promise<void> };
    autoMode?: {
      setAgent(ownerId: string, agentSlug: string, body: unknown): Promise<{ ok: true } | { ok: false; error: string }>;
      setTree(ownerId: string, treeId: string, body: unknown): Promise<{ ok: true } | { ok: false; error: string }>;
    } | undefined;
    treeOfRun?: ((turnId: string) => string | undefined) | undefined;
  }) {}

  async approve(ownerId: string, runId: string, request: ApprovalRequest): Promise<ApprovalOutcome> {
    if (!(await this.deps.store.ownsRun(ownerId, runId))) return 'not-yours';
    if (request.allowed && request.conversation) {
      if (!(await this.deps.store.allowToolInConversation(ownerId, request.conversation.id, request.conversation.tool))) return 'no-such-conversation';
    }
    if (request.allowed && request.auto) {
      const switched = await this.autoModeFor(ownerId, runId, request.auto);
      if (switched) return { refused: switched };
    }
    await this.deps.runs.approve(runId, request.callId, request.allowed, request.forRun === true);
    return 'sent';
  }

  private async autoModeFor(ownerId: string, runId: string, scope: 'agent' | 'tree'): Promise<string | undefined> {
    if (!this.deps.autoMode) return 'auto mode cannot be switched on from here';
    const origin = await this.deps.store.runOrigin(ownerId, runId);
    if (scope === 'agent') {
      if (!origin?.agentId) return 'this run does not say which agent it is, so auto mode was not switched on';
      const set = await this.deps.autoMode.setAgent(ownerId, origin.agentId, { on: true });
      return set.ok ? undefined : set.error;
    }
    const treeId = origin ? this.deps.treeOfRun?.(origin.turnId) : undefined;
    if (!treeId) return 'this run is not part of a tree\'s work, so there is no tree to switch auto mode on for';
    const set = await this.deps.autoMode.setTree(ownerId, treeId, { on: true });
    return set.ok ? undefined : set.error;
  }
}
