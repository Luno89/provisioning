import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import type { AgentChange } from '../lib/agent-changes.js';
import { AgentChangeService } from './AgentChangeService.js';

let db: MemoryDB;
let savedPrompts: [string, string][];
let handed: string[];
let refuse: string[] | undefined;

const changes = () => new AgentChangeService({
  store: db,
  savePrompt: async (_ownerId, agent, prompt) => {
    if (refuse) return { saved: false, problems: refuse };
    savedPrompts.push([agent, prompt]);
    return { saved: true };
  },
  handOff: async (_ownerId, message) => { handed.push(message); return { conversationId: 'conv-builder', runId: 'run-builder' }; },
  now: () => 'now',
});

const prompt = (over: Partial<AgentChange> = {}): AgentChange => ({ id: 'c1', ownerId: 'u1', kind: 'prompt', agent: 'koala', prompt: 'new prompt', currentPrompt: 'old prompt', why: 'it guessed', status: 'ready', createdAt: 'a', ...over } as AgentChange);
const request = (over: Partial<AgentChange> = {}): AgentChange => ({ id: 'r1', ownerId: 'u1', kind: 'procedure', agent: 'research', procedure: 'research', request: 'end failed on an empty reply', why: 'run r-3 ended ok with nothing', status: 'proposed', createdAt: 'b', ...over } as AgentChange);

beforeEach(() => {
  db = new MemoryDB();
  savedPrompts = [];
  handed = [];
  refuse = undefined;
});

describe('a proposed prompt change', () => {
  it('is accepted only once the bench has compared it, saving the agent with the new prompt — or the person\'s edit of it', async () => {
    await db.saveEvalRecord('evalAgentChanges', prompt({ status: 'comparing' }));
    expect(await changes().accept('u1', 'c1')).toMatchObject({ accepted: false, status: 409 });

    await db.saveEvalRecord('evalAgentChanges', prompt());
    expect(await changes().accept('u1', 'c1', 'edited prompt')).toMatchObject({ accepted: true, change: { status: 'accepted', prompt: 'edited prompt' } });
    expect(savedPrompts).toEqual([['koala', 'edited prompt']]);
  });

  it('stays waiting when the agent cannot be saved with it, saying why', async () => {
    await db.saveEvalRecord('evalAgentChanges', prompt());
    refuse = ['the prompt is empty'];
    expect(await changes().accept('u1', 'c1')).toEqual({ accepted: false, status: 400, problems: ['the prompt is empty'] });
    expect((await changes().list('u1'))[0]!.status).toBe('ready');
  });

  it('only counts waiting ones as pending for the bench, and can be dismissed', async () => {
    await db.saveEvalRecord('evalAgentChanges', prompt({ status: 'proposed' }));
    await db.saveEvalRecord('evalAgentChanges', prompt({ id: 'c2', status: 'accepted' }));
    expect((await changes().pending('u1')).map((change) => change.id)).toEqual(['c1']);
    expect(await changes().dismiss('u1', 'c1')).toBe(true);
    expect(await changes().dismiss('u1', 'c2')).toBe(false);
  });
});

describe('a procedure change request', () => {
  it('is handed to the agent builder with what should change and why, and remembers which conversation took it', async () => {
    await db.saveEvalRecord('evalAgentChanges', request());

    const outcome = await changes().handOver('u1', 'r1');

    expect(outcome).toMatchObject({ accepted: true, change: { status: 'handed-over', conversationId: 'conv-builder', runId: 'run-builder' } });
    expect(handed[0]).toContain('A change to the procedure "research" was requested, for the agent "research".');
    expect(handed[0]).toContain('What should change: end failed on an empty reply');
    expect(handed[0]).toContain('Why: run r-3 ended ok with nothing');
    expect(await changes().handOver('u1', 'r1')).toMatchObject({ accepted: false, status: 409 });
  });
});
