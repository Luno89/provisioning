import { describe, expect, it } from 'vitest';
import { recordFor, relayProblem, requestProblem, statusFor, type HubStatus } from './hub-board.js';

const board = {
  trees: [{ id: 't1' }],
  branches: [{ id: 'b1', treeId: 't1' }, { id: 'b2', treeId: 't1' }],
  leaves: [{ id: 'l1', branchId: 'b1' }, { id: 'l2', branchId: 'b1' }, { id: 'l3', branchId: 'b2' }],
  tasks: [{ id: 'k1' }],
  planProposals: [{ id: 'p1' }],
  conversations: [{ id: 'channel-x' }],
};

describe('what each role sees of a shared project', () => {
  it('shows a client a story and its tasks without how they were worked, and never the owner\'s id', () => {
    const leaf = { id: 'l1', ownerId: 'ann', branchId: 'b1', title: 'Pay', status: 'claimed', runId: 'r', claim: { evidence: 'diff', at: 'x' }, attempts: [{}], review: {}, drops: [], createdAt: 'a', updatedAt: 'b' };
    expect(recordFor('client', 'leaves', leaf)).toEqual({ id: 'l1', branchId: 'b1', title: 'Pay', status: 'claimed', createdAt: 'a', updatedAt: 'b' });
    expect(recordFor('collaborator', 'leaves', leaf)).not.toHaveProperty('ownerId');
    expect(recordFor('collaborator', 'leaves', leaf)).toHaveProperty('claim');
    const task = { id: 'k1', ownerId: 'ann', title: 'Pay', doneMeans: 'paid', checks: { run: 'npm test' }, runs: ['r'], evidence: 'e', status: 'done', dependsOn: [] };
    expect(recordFor('client', 'tasks', task)).toEqual({ id: 'k1', title: 'Pay', doneMeans: 'paid', status: 'done', dependsOn: [] });
  });

  it('shows a client a chat\'s words without Koala\'s reasoning or the chat\'s settings', () => {
    const chat = { id: 'c', ownerId: 'ann', kind: 'channel', modelId: 'm', autoMode: true, allowedTools: ['x'], messages: [{ role: 'assistant', content: 'done', at: '1', reasoning: 'thinking', toolCalls: [{}] }] };
    expect(recordFor('client', 'conversations', chat)).toEqual({ id: 'c', kind: 'channel', messages: [{ role: 'assistant', content: 'done', at: '1' }] });
  });

  it('tells a client what is live and what waits, but no builds, commits or how the trees run', () => {
    const status: HubStatus = {
      at: 'now',
      releases: [{ id: 'r1', state: 'live', slot: 'a', commit: 'abc', startedAt: '1', liveAt: '2', changes: { dropped: [] } }],
      addresses: { live: 'https://shop' },
      runs: [{ id: 'b1', startedAt: '1', promotedAt: '2', commitSha: 'abc', status: 'success' }, { id: 'b2', startedAt: '3', status: 'failed', errorMessage: 'boom' }],
      treeRuns: { t1: { state: 'running', asking: [] } },
    };
    expect(statusFor('client', status)).toEqual({
      at: 'now',
      releases: [{ id: 'r1', state: 'live', slot: 'a', startedAt: '1', liveAt: '2' }],
      addresses: { live: 'https://shop' },
      runs: [{ id: 'b1', startedAt: '1', promotedAt: '2' }],
      treeRuns: {},
    });
    expect(statusFor('owner', status)).toBe(status);
  });
});

describe('what each role may ask the owner\'s instance to do', () => {
  it('lets owners and collaborators change the work, and refuses a client', () => {
    expect(requestProblem('approve-plan', { proposalId: 'p1' }, 'collaborator', board)).toBeUndefined();
    expect(requestProblem('approve-plan', { proposalId: 'p1' }, 'client', board)).toEqual({ status: 403, why: 'only an owner or a collaborator can change the work' });
    expect(requestProblem('accept-task', { taskId: 'k1' }, 'owner', board)).toBeUndefined();
  });

  it('refuses anything that is not this project\'s, and an order that mixes features', () => {
    expect(requestProblem('approve-plan', { proposalId: 'elsewhere' }, 'owner', board)?.status).toBe(400);
    expect(requestProblem('order-stories', { branchId: 'b1', leafIds: ['l2', 'l1'] }, 'owner', board)).toBeUndefined();
    expect(requestProblem('order-stories', { branchId: 'b1', leafIds: ['l2', 'l3'] }, 'owner', board)?.status).toBe(400);
    expect(requestProblem('order-features', { treeId: 't1', branchIds: ['b2', 'b1'] }, 'owner', board)).toBeUndefined();
    expect(requestProblem('cut-over', {}, 'owner', board)?.status).toBe(400);
  });

  it('has Koala answer an owner or a client on the owner\'s instance, and a collaborator only from their own', () => {
    const ask = { conversationId: 'channel-x', at: '1', content: 'hi' };
    expect(requestProblem('ask-koala', ask, 'client', board)).toBeUndefined();
    expect(requestProblem('ask-koala', ask, 'owner', board)).toBeUndefined();
    expect(requestProblem('ask-koala', ask, 'collaborator', board)?.status).toBe(403);
    expect(requestProblem('ask-koala', { ...ask, conversationId: 'private' }, 'client', board)?.status).toBe(400);
  });

  it('keeps how the work runs and changing files to owners and collaborators', () => {
    expect(relayProblem('turns', 'client')).toBeDefined();
    expect(relayProblem('files.remove', 'client')).toBeDefined();
    expect(relayProblem('files.upload', 'client')).toBeUndefined();
    expect(relayProblem('turns', 'collaborator')).toBeUndefined();
  });
});
