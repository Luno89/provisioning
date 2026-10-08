export interface ApprovalRequest {
  callId: string;
  allowed: boolean;
  forRun?: boolean | undefined;
  conversation?: { id: string; tool: string } | undefined;
}

export type ApprovalOutcome = 'sent' | 'not-yours' | 'no-such-conversation';

export class ApprovalService {
  constructor(private readonly deps: {
    store: {
      ownsRun(ownerId: string, runId: string): Promise<boolean>;
      allowToolInConversation(ownerId: string, conversationId: string, tool: string): Promise<boolean>;
    };
    runs: { approve(runId: string, callId: string, allowed: boolean, forRun?: boolean): Promise<void> };
  }) {}

  async approve(ownerId: string, runId: string, request: ApprovalRequest): Promise<ApprovalOutcome> {
    if (!(await this.deps.store.ownsRun(ownerId, runId))) return 'not-yours';
    if (request.allowed && request.conversation) {
      if (!(await this.deps.store.allowToolInConversation(ownerId, request.conversation.id, request.conversation.tool))) return 'no-such-conversation';
    }
    await this.deps.runs.approve(runId, request.callId, request.allowed, request.forRun === true);
    return 'sent';
  }
}
