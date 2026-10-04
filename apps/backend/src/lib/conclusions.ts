import type { Conversation, ConversationMessage } from './conversations.js';
import type { Leaf } from './leaves.js';

export const DEFAULT_CONCLUDE_AFTER_MINUTES = 10;
export const MEMORY_KEEPER = 'memory-keeper';
export const DEFAULT_CHAT_AGENT = 'koala';
export const LEAF_JUDGE = 'leaf-judge';

export interface Conclusion {
  ownerId: string;
  runId: string;
  message: string;
  projectId?: string | undefined;
  treeId?: string | undefined;
}

const safeId = (value: string): string => value.replace(/[^A-Za-z0-9_-]+/g, '-');

const line = (message: ConversationMessage, agent: string): string => {
  const calls = (message.toolCalls ?? []).map((call) => `  [${call.name} ${call.ok ? 'gave' : 'failed'}: ${call.digest}]`);
  return [`${message.role === 'assistant' ? agent : 'person'}: ${message.content}`, ...calls].join('\n');
};

export interface FinishedRun {
  runId: string;
  ownerId: string;
  agentSlug: string;
  outcome: string;
  reason?: string | undefined;
  ask: string;
}

export function conversationConclusion(
  conversation: Conversation,
  rememberedThrough: number,
  why: 'quiet' | 'settled',
): Conclusion | undefined {
  const fresh = conversation.messages.slice(rememberedThrough);
  if (fresh.length === 0) return undefined;
  const settled = why === 'settled';
  const agent = conversation.agentSlug ?? DEFAULT_CHAT_AGENT;

  const through = conversation.messages.length;
  return {
    ownerId: conversation.ownerId,
    runId: `memory-conversation-${safeId(conversation.id)}-${through}`,
    ...(conversation.projectId ? { projectId: conversation.projectId } : {}),
    ...(conversation.treeId ? { treeId: conversation.treeId } : {}),
    message: [
      `A conversation with the person has reached a conclusion${settled ? ' (something was decided in it)' : ' (it has gone quiet)'}. `
        + 'Remember what in it will still matter in later conversations: what the person prefers, what they decided, '
        + 'facts about their setup and projects, and what went wrong and why. Leave out what only mattered to this exchange.',
      '',
      `Conversation "${conversation.title}" between the person and the agent "${agent}", the part not yet remembered (messages ${rememberedThrough + 1} to ${through}):`,
      '',
      fresh.map((message) => line(message, agent)).join('\n\n'),
    ].join('\n'),
  };
}

export function leafConclusion(leaf: Leaf, treeId: string | undefined): Conclusion | undefined {
  const review = leaf.review;
  if (review?.model !== LEAF_JUDGE) return undefined;
  const verdict = leaf.status === 'succeeded' ? 'verified' : leaf.status === 'failed' ? 'failed' : 'left for a person';
  return {
    ownerId: leaf.ownerId,
    runId: `memory-leaf-${safeId(leaf.id)}-${safeId(review.at)}`,
    ...(treeId ? { treeId } : {}),
    message: [
      `A judge has settled a piece of work: the leaf "${leaf.title}" was ${verdict}. `
        + 'Remember what this teaches about the project and how to work on it — where things live, commands that work or do not, '
        + 'tools and services that are or are not available, and why the work succeeded or failed. The judge checked these against the work itself.',
      '',
      `Goal: ${leaf.body ?? leaf.title}`,
      `The judge's note: ${review.reason ?? leaf.findings ?? '(none)'}`,
      ...(leaf.claim ? [`What the work claimed: ${leaf.claim.evidence}`] : []),
      ...(leaf.claim?.runs?.length ? [`The runs that did the work, which read_run can open: ${leaf.claim.runs.join(', ')}`] : []),
    ].join('\n'),
  };
}

export function runConclusion(run: FinishedRun): Conclusion | undefined {
  if (run.agentSlug === MEMORY_KEEPER) return undefined;
  if (run.outcome === 'ok' && run.agentSlug !== 'research') return undefined;
  return {
    ownerId: run.ownerId,
    runId: `memory-run-${safeId(run.runId)}`,
    message: run.outcome === 'ok'
      ? [
        `A research run has finished (run ${run.runId}). Remember the durable facts it established — `
          + 'what is true about the tools, services and projects the person works with — not the question itself. '
          + 'Read the run with read_run to see what it found and where it found it.',
        '',
        `It was asked: ${run.ask}`,
      ].join('\n')
      : [
        `A run of the agent "${run.agentSlug}" ended ${run.outcome} (run ${run.runId}). `
          + 'Read it with read_run and remember what went wrong and why, if it is something a later run should know '
          + 'so it does not happen again. Leave out failures that only happened once for no lasting reason.',
        '',
        `It was asked: ${run.ask}`,
        ...(run.reason ? [`It ended because: ${run.reason}`] : []),
      ].join('\n'),
  };
}
