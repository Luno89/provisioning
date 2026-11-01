import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { memoriesRouter } from './memories.js';
import type { ConsolidationReport } from '../lib/memory-consolidate.js';

describe('/api/memories', () => {
  let harness: Harness;
  const report: ConsolidationReport = { at: '2026-10-31T00:00:00.000Z', indexed: 0, deduped: 0, promoted: 0, decayed: 0, unreachable: 0, live: 3 };

  beforeEach(async () => {
    harness = await mountRouter({
      prefix: '/api/memories',
      router: (db) => memoriesRouter({ db, temporalBridge: { lastConsolidation: report } }),
    });
  });

  afterEach(() => harness.close());

  it('shows the last consolidation, which covers everyone\'s memories, only to the operator', async () => {
    const refused = await axios.get(harness.url('/api/memories/consolidation'), { validateStatus: () => true });
    expect([refused.status, refused.data]).toEqual([403, { error: 'Only the operator of this server can do that.' }]);
    harness.setUser({ ...TEST_USER, roles: ['operator' as const] });
    expect((await axios.get(harness.url('/api/memories/consolidation'))).data).toEqual(report);
  });

  it('keeps a memory for one model when the person says which, and lets them make it hold for every model again', async () => {
    const made = await axios.post<{ id: string }>(harness.url('/api/memories'), { category: 'lessons_learned', title: 'Arguments', text: 'Send objects.', scope: 'global', model: ' qwen/q ' });
    expect(made.data).toMatchObject({ model: 'qwen/q' });

    const renamed = await axios.put(harness.url(`/api/memories/${made.data.id}`), { title: 'Arguments as objects' });
    expect(renamed.data).toMatchObject({ title: 'Arguments as objects', model: 'qwen/q' });

    const everyone = await axios.put(harness.url(`/api/memories/${made.data.id}`), { model: null });
    expect(everyone.data).not.toHaveProperty('model');
    expect((await harness.db.memory.getMemories(TEST_USER.id))[0]).not.toHaveProperty('model');
  });

  it('lists memories without the notes learned about tools, which live on the tools\' pages', async () => {
    await harness.db.memory.saveMemory({ id: 'n1', ownerId: TEST_USER.id, category: 'tool_note', tool: 'start_task', status: 'active', title: 'Claim', text: 'Claim first.', createdAt: 'a', updatedAt: 'a' });
    await axios.post(harness.url('/api/memories'), { category: 'lessons_learned', title: 'Kept', text: 'A lesson.', scope: 'global' });
    expect((await axios.get<{ title: string }[]>(harness.url('/api/memories'))).data.map((memory: { title: string }) => memory.title)).toEqual(['Kept']);
  });

  it('refuses a kind, scope or state of memory that does not exist rather than storing it', async () => {
    const odd = await axios.post(harness.url('/api/memories'), { category: 'gossip', title: 'T', text: 'X' }, { validateStatus: () => true });
    expect([odd.status, odd.data]).toEqual([400, { error: 'gossip is not a kind of memory' }]);
    const made = await axios.post<{ id: string }>(harness.url('/api/memories'), { category: 'lessons_learned', title: 'T', text: 'X', scope: 'global' });
    const scoped = await axios.put(harness.url(`/api/memories/${made.data.id}`), { scope: 'everywhere' }, { validateStatus: () => true });
    expect([scoped.status, scoped.data]).toEqual([400, { error: 'a memory\'s scope is project or global, not everywhere' }]);
    const stated = await axios.put(harness.url(`/api/memories/${made.data.id}`), { status: 'archived' }, { validateStatus: () => true });
    expect(stated.status).toBe(400);
    expect((await harness.db.memory.getMemories(TEST_USER.id))[0]).toMatchObject({ scope: 'global', status: 'active' });
  });

  it('keeps one for every model when no model is given', async () => {
    const made = await axios.post<{ id: string }>(harness.url('/api/memories'), { category: 'environment_facts', title: 'DNS', text: 'Cloudflare.', scope: 'global', model: '' });
    expect(made.data).not.toHaveProperty('model');
  });
});
