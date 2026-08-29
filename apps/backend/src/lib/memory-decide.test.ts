import { describe, it, expect } from 'vitest';
import {
  parseDecision, applyDecision, admitMemory, buildDecidePrompt, MAX_NEIGHBOURS,
} from './memory-decide.js';
import type { MemoryItem } from './memory-store.js';

const mem = (over: Partial<MemoryItem> = {}): MemoryItem => ({
  id: 'cand', ownerId: 'u1', projectId: 'p1', category: 'lessons_learned', scope: 'project',
  title: 'A lesson', text: 'Something learned.',
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

const neighbours = [mem({ id: 'n1', title: 'Stored one' }), mem({ id: 'n2', title: 'Stored two' })];

describe('what the model is allowed to say', () => {
  it('accepts the four decisions', () => {
    expect(parseDecision('{"action":"ADD"}', neighbours)).toEqual({ action: 'ADD' });
    expect(parseDecision('{"action":"NOOP"}', neighbours)).toEqual({ action: 'NOOP' });
    expect(parseDecision('{"action":"UPDATE","id":"n1"}', neighbours)).toEqual({ action: 'UPDATE', targetId: 'n1' });
    expect(parseDecision('{"action":"DELETE","id":"n2"}', neighbours)).toEqual({ action: 'DELETE', targetId: 'n2' });
  });

  it('reads the JSON out of a reply that also thought out loud', () => {
    expect(parseDecision('We should keep this.\n{"action":"ADD"}\n', neighbours)).toEqual({ action: 'ADD' });
  });

  it('discards a decision naming an id it was never shown', () => {
    expect(parseDecision('{"action":"DELETE","id":"someone-elses-memory"}', neighbours)).toEqual({ action: 'NOOP' });
    expect(parseDecision('{"action":"UPDATE","id":""}', neighbours)).toEqual({ action: 'NOOP' });
  });

  it('cannot express a scope change at all', () => {
    const decision = parseDecision('{"action":"ADD","scope":"global","ownerId":"someone-else"}', neighbours);
    expect(decision).toEqual({ action: 'ADD' });

    const [written] = applyDecision(decision, mem(), neighbours);
    expect(written!.scope).toBe('project');
    expect(written!.ownerId).toBe('u1');
  });

  it('falls back to ADD when the reply is not JSON at all', () => {
    expect(parseDecision('I think you should keep it.', neighbours)).toEqual({ action: 'ADD' });
    expect(parseDecision('{"action":', neighbours)).toEqual({ action: 'ADD' });
    expect(parseDecision('{"action":"FRobnicate"}', neighbours)).toEqual({ action: 'ADD' });
  });
});

describe('what a decision does to the bank', () => {
  it('never produces a deletion', () => {
    for (const reply of ['{"action":"DELETE","id":"n1"}', '{"action":"UPDATE","id":"n1"}', '{"action":"NOOP"}']) {
      const written = applyDecision(parseDecision(reply, neighbours), mem(), neighbours, 'NOW');
      expect(written.every((m) => typeof m.id === 'string')).toBe(true);
    }
  });

  it('supersedes as a new row, keeping the old one and its pointer', () => {
    const written = applyDecision({ action: 'UPDATE', targetId: 'n1' }, mem(), neighbours, 'NOW');

    expect(written.map((m) => m.id)).toEqual(['n1', 'cand']);
    expect(written[0]!.invalidAt).toBe('NOW');
    expect(written[0]!.supersededBy).toBe('cand');
    expect(written[1]!.invalidAt).toBeUndefined();
  });

  it('retires without a successor on DELETE, and stores nothing new', () => {
    const written = applyDecision({ action: 'DELETE', targetId: 'n2' }, mem(), neighbours, 'NOW');

    expect(written.map((m) => m.id)).toEqual(['n2']);
    expect(written[0]!.invalidAt).toBe('NOW');
    expect(written[0]!.supersededBy).toBeUndefined();
  });

  it('writes nothing at all on NOOP', () => {
    expect(applyDecision({ action: 'NOOP' }, mem(), neighbours)).toEqual([]);
  });

  it('still stores the candidate when the named target has vanished', () => {
    expect(applyDecision({ action: 'UPDATE', targetId: 'n1' }, mem(), []).map((m) => m.id)).toEqual(['cand']);
  });
});

describe('admission end to end', () => {
  const ask = (reply: string) => async () => reply;

  it('asks about the nearest neighbours and honours the answer', async () => {
    let sawPrompt = '';
    const out = await admitMemory({
      neighbours: async () => neighbours,
      ask: async (p) => { sawPrompt = p; return '{"action":"NOOP"}'; },
    }, mem());

    expect(sawPrompt).toContain('Stored one');
    expect(out.decision).toEqual({ action: 'NOOP' });
    expect(out.write).toEqual([]);
  });

  it('caps how many neighbours reach the prompt', async () => {
    const many = Array.from({ length: 20 }, (_, i) => mem({ id: `n${i}`, title: `Stored ${i}` }));
    let sawPrompt = '';
    await admitMemory({
      neighbours: async () => many,
      ask: async (p) => { sawPrompt = p; return '{"action":"ADD"}'; },
    }, mem());

    expect(sawPrompt).toContain('Stored 0');
    expect(sawPrompt).not.toContain(`Stored ${MAX_NEIGHBOURS}`);
  });

  it('stores the candidate when there is no model to ask', async () => {
    const out = await admitMemory({ neighbours: async () => neighbours }, mem());
    expect(out.write.map((m) => m.id)).toEqual(['cand']);
  });

  it('stores the candidate when retrieval fails', async () => {
    const out = await admitMemory({
      neighbours: async () => { throw new Error('Qdrant down'); },
      ask: ask('{"action":"NOOP"}'),
    }, mem());
    expect(out.write.map((m) => m.id)).toEqual(['cand']);
  });

  it('stores the candidate when the model call fails', async () => {
    const out = await admitMemory({
      neighbours: async () => neighbours,
      ask: async () => { throw new Error('model unreachable'); },
    }, mem());
    expect(out.decision).toEqual({ action: 'ADD' });
    expect(out.write.map((m) => m.id)).toEqual(['cand']);
  });

  it('handles an empty bank without pretending there were neighbours', async () => {
    let sawPrompt = '';
    await admitMemory({
      neighbours: async () => [],
      ask: async (p) => { sawPrompt = p; return '{"action":"ADD"}'; },
    }, mem());

    expect(sawPrompt).toContain('nothing similar is stored');
  });
});

describe('the prompt', () => {
  it('shows the candidate and asks for JSON only', () => {
    const p = buildDecidePrompt(mem({ title: 'THE CANDIDATE' }), neighbours);
    expect(p).toContain('THE CANDIDATE');
    expect(p).toContain('JSON only');
    expect(p).toContain('Prefer NOOP over ADD when unsure');
  });
});
