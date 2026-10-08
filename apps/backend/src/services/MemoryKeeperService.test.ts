import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { MemoryKeeperService, type ConversationTimer, type StartMemoryRun } from './MemoryKeeperService.js';
import type { LifecycleEvent } from '../engine-host/temporal/contracts.js';

let db: MemoryDB;
let started: Parameters<StartMemoryRun>[0][];
let timers: Parameters<ConversationTimer>[0][];
let refuse: string | undefined;
let minutes: number | undefined;
let forgetful: Set<string>;

const keeper = () => new MemoryKeeperService({
  store: db,
  start: async (request) => {
    if (refuse) throw new Error(refuse);
    started.push(request);
  },
  timer: async (request) => { timers.push(request); },
  concludeAfterMinutes: async () => minutes,
  remembersFor: async (ownerId) => !forgetful.has(ownerId),
});

const say = async (content: string) => {
  const existing = await db.getConversation('u1', 'c1');
  const message = { role: 'user' as const, content, at: '2026-10-03T12:00:00Z' };
  await db.saveConversation(existing
    ? { ...existing, messages: [...existing.messages, message] }
    : { id: 'c1', ownerId: 'u1', title: 'chat', messages: [message], createdAt: message.at, updatedAt: message.at });
};

const quiet: LifecycleEvent = { kind: 'conversation-quiet', ownerId: 'u1', conversationId: 'c1' };

const turnEnded = (over: Partial<Extract<LifecycleEvent, { kind: 'run-ended' }>> = {}): LifecycleEvent => ({
  kind: 'run-ended', ownerId: 'u1', runId: 'run-1', agentSlug: 'koala', outcome: 'ok', ask: 'hi', depth: 0, conversationId: 'c1', ...over,
});

beforeEach(() => {
  db = new MemoryDB();
  started = [];
  timers = [];
  refuse = undefined;
  forgetful = new Set();
  minutes = undefined;
});

describe('the memory keeper, driven by what the engine reports', () => {
  it('holds a conversation\'s countdown while a turn runs, and restarts it with the agent\'s own setting when the turn ends', async () => {
    minutes = 25;

    await keeper().handle({ kind: 'run-started', ownerId: 'u1', runId: 'run-1', agentSlug: 'koala', depth: 0, conversationId: 'c1' });
    await keeper().handle(turnEnded());

    expect(timers).toEqual([
      { ownerId: 'u1', conversationId: 'c1', signal: 'turnStarted' },
      { ownerId: 'u1', conversationId: 'c1', signal: 'turnEnded', quietMs: 25 * 60_000 },
    ]);
  });

  it('counts down ten minutes when the agent says nothing', async () => {
    await keeper().handle(turnEnded());
    expect(timers[0]).toMatchObject({ quietMs: 10 * 60_000 });
  });

  it('starts no countdown for a delegated run, or for the memory keeper\'s own runs', async () => {
    await keeper().handle(turnEnded({ depth: 1 }));
    await keeper().handle(turnEnded({ agentSlug: 'memory-keeper' }));
    expect(timers).toEqual([]);
  });

  it('remembers a conversation once its countdown runs out, and later only what was said after', async () => {
    await say('We use Cloudflare for DNS.');
    expect((await keeper().handle(quiet)).started).toEqual(['memory-conversation-c1-1']);
    expect(started[0]).toMatchObject({ ownerId: 'u1', agentSlug: 'memory-keeper' });
    expect((await keeper().handle(quiet)).started).toEqual([]);

    await say('Trials last 7 days.');
    expect((await keeper().handle(quiet)).started).toEqual(['memory-conversation-c1-2']);
    expect(started[1]!.message).toContain('Trials last 7 days.');
    expect(started[1]!.message).not.toContain('Cloudflare');
  });

  it('remembers a conversation at once when something is settled in it', async () => {
    await say('Deploy it.');
    expect((await keeper().settled('u1', 'c1')).started).toEqual(['memory-conversation-c1-1']);
  });

  it('lets a run that could not start fail, so Temporal tries the event again rather than losing it', async () => {
    await say('Remember this.');
    refuse = 'Temporal is not reachable';

    await expect(keeper().handle(quiet)).rejects.toThrow('Temporal is not reachable');
    refuse = undefined;
    expect((await keeper().handle(quiet)).started).toEqual(['memory-conversation-c1-1']);
  });

  it('counts a run that already started as begun, so a repeated event never doubles it', async () => {
    await say('Remember this.');
    refuse = 'Workflow execution already started';

    expect((await keeper().handle(quiet)).started).toEqual(['memory-conversation-c1-1']);
  });

  it('hands the memory keeper a failed run, research, and a leaf its judge settled — and nothing for a run that just went fine', async () => {
    await db.saveBranch({ id: 'b1', ownerId: 'u1', treeId: 't1', title: 'b', createdAt: 'x', updatedAt: 'x' } as never);
    await db.saveLeaf({ id: 'leaf-1', ownerId: 'u1', branchId: 'b1', title: 'versions.txt', status: 'failed', review: { verdict: 'unsound', model: 'leaf-judge', at: '2026-10-03T12:00:00Z', reason: 'frobnicate is missing' }, createdAt: 'x', updatedAt: 'x' });

    await keeper().handle(turnEnded({ runId: 'r-failed', agentSlug: 'executor', outcome: 'failed', depth: 1 }));
    await keeper().handle(turnEnded({ runId: 'r-research', agentSlug: 'research', depth: 1 }));
    await keeper().handle(turnEnded({ runId: 'r-judge', agentSlug: 'leaf-judge', depth: 1, leafId: 'leaf-1' }));
    await keeper().handle(turnEnded({ runId: 'r-fine', agentSlug: 'executor', depth: 1 }));

    expect(started.map((request) => request.runId)).toEqual(['memory-run-r-failed', 'memory-run-r-research', 'memory-leaf-leaf-1-2026-10-03T12-00-00Z']);
    expect(started[2]!.bound).toEqual({ treeId: 't1' });
  });
});

describe('accounts nothing should be remembered for', () => {
  it('starts no keeper for a check\'s space or an account being removed', async () => {
    forgetful.add('u1');
    const report = await keeper().handle(turnEnded({ agentSlug: 'research', conversationId: undefined }));
    expect(report.started).toEqual([]);
    expect(started).toEqual([]);
  });
});
