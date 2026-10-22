export const CONVERSATION_CONCLUSION_WORKFLOW = 'ConversationConclusionWorkflow';
export const CONCLUDE_WORKSPACE_WORKFLOW = 'ConcludeWorkspaceWorkflow';
export const BENCH_IDLE_WORKFLOW = 'BenchIdleWorkflow';

export interface ConcludedWorkspace {
  kind: 'conversation' | 'tree';
  id: string;
}

export const concludeWorkspaceId = (workspace: ConcludedWorkspace): string => `conclude-workspace-${workspace.kind}-${workspace.id}`;
export const benchIdleId = (ownerId: string): string => `bench-idle-${ownerId}`;
export const conversationConclusionId = (conversationId: string): string => `conclude-conversation-${conversationId}`;

export const groveRunWorkflowId = (treeId: string): string => `grove-run-${treeId}`;
export const RUN_ID_MEMO = 'runId';
export const RUN_AGENT_MEMO = 'agent';
export const RUN_CONVERSATION_MEMO = 'conversation';
export const RUN_ABOUT_MEMO = 'about';
export const runStamp = (at: number = Date.now()): string => at.toString(36);
export const groveRunId = (treeId: string, stamp: string): string => `${groveRunWorkflowId(treeId)}~${stamp}`;
export const treeOfGroveRun = (runId: string): string | undefined => /^grove-run-([^~]+)~[0-9a-z]+$/.exec(runId)?.[1];
export const workflowOfRun = (runId: string): string => runId.replace(/~[0-9a-z]+$/, '');
export const adoptionWorkflowId = (proposalId: string): string => `adopt-plan-${proposalId}`;
