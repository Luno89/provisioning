import { describe, it, expect } from 'vitest';
import { conversationConclusion, leafConclusion, runConclusion, type FinishedRun } from './conclusions.js';
import type { Conversation } from './conversations.js';
import type { Leaf } from './leaves.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const MINUTE = 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const conversation = (lastAt: string): Conversation => ({
  id: 'c1',
  ownerId: 'u1',
  title: 'Setting up the cluster',
  projectId: 'p1',
  messages: [
    { role: 'user', content: 'We use Cloudflare for DNS.', at: ago((10 * MINUTE) * 3) },
    { role: 'assistant', content: 'Noted.', at: ago((10 * MINUTE) * 2), toolCalls: [{ id: 't', name: 'list_infrastructure', args: '{}', ok: true, digest: '2 clusters' }] },
    { role: 'user', content: 'And trials last 7 days.', at: lastAt },
  ],
  createdAt: ago((10 * MINUTE) * 3),
  updatedAt: lastAt,
});

describe('what a concluded conversation hands the memory keeper', () => {
  it('says why it concluded', () => {
    expect(conversationConclusion(conversation(ago(1000)), 0, 'quiet')!.message).toContain('it has gone quiet');
    expect(conversationConclusion(conversation(ago(1000)), 0, 'settled')!.message).toContain('something was decided in it');
  });

  it('hands over only what was not yet remembered, with the tool calls, under an id that names how far it got', () => {
    const conclusion = conversationConclusion(conversation(ago(1000)), 1, 'quiet')!;

    expect(conclusion.runId).toBe('memory-conversation-c1-3');
    expect(conclusion.projectId).toBe('p1');
    expect(conclusion.message).not.toContain('We use Cloudflare');
    expect(conclusion.message).toContain('between the person and the agent "koala"');
    expect(conclusion.message).toContain('koala: Noted.');
    expect(conclusion.message).toContain('[list_infrastructure gave: 2 clusters]');
    expect(conclusion.message).toContain('person: And trials last 7 days.');
  });

  it('has nothing to conclude once everything is remembered', () => {
    expect(conversationConclusion(conversation(ago(1000)), 3, 'settled')).toBeUndefined();
  });
});

const leaf = (over: Partial<Leaf>): Leaf => ({
  id: 'leaf-1', ownerId: 'u1', branchId: 'b1', title: 'versions.txt', status: 'failed', createdAt: 'x', updatedAt: 'x', ...over,
});

describe('a judged leaf', () => {
  it('concludes once its judge has settled it, carrying the note and the runs to read, bound to its tree', () => {
    const settled = leaf({
      body: 'versions.txt holds frobnicate --version',
      review: { verdict: 'unsound', model: 'leaf-judge', at: ago(1000), reason: 'frobnicate is not installed anywhere in the workspace' },
      claim: { evidence: '[failed]', at: ago(2000), runs: ['run-exec-1'] },
    });

    const conclusion = leafConclusion(settled, 'tree-1');

    expect(conclusion).toMatchObject({ ownerId: 'u1', treeId: 'tree-1' });
    expect(conclusion!.message).toContain('was failed');
    expect(conclusion!.message).toContain('frobnicate is not installed anywhere');
    expect(conclusion!.message).toContain('run-exec-1');
  });

  it('leaves alone what its own checks settled', () => {
    expect(leafConclusion(leaf({ review: { verdict: 'unsound', model: 'grove-check-runner', at: ago(1000) } }), undefined)).toBeUndefined();
  });
});

const run = (over: Partial<FinishedRun>): FinishedRun => ({ runId: 'r1', ownerId: 'u1', agentSlug: 'executor', outcome: 'ok', ask: 'do it', ...over });

describe('a finished run', () => {
  it('concludes when it failed, or when it was research, and never for the memory keeper itself', () => {
    expect(runConclusion(run({}))).toBeUndefined();
    expect(runConclusion(run({ runId: 'failed-run', outcome: 'failed', reason: 'the model stopped answering' }))!.message).toContain('the model stopped answering');
    expect(runConclusion(run({ runId: 'research-run', agentSlug: 'research', ask: 'What does jq -r do?' }))!.runId).toBe('memory-run-research-run');
    expect(runConclusion(run({ agentSlug: 'memory-keeper', outcome: 'failed' }))).toBeUndefined();
  });
});
