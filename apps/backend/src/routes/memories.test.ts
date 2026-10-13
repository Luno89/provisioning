import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { memoriesRouter } from './memories.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';

describe('/api/memories', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await mountRouter({
      prefix: '/api/memories',
      router: (db) => memoriesRouter({ db, temporalBridge: {} as TemporalBridge }),
    });
  });

  afterEach(() => harness.close());

  it('keeps a memory for one model when the person says which, and lets them make it hold for every model again', async () => {
    const made = await axios.post(harness.url('/api/memories'), { category: 'lessons_learned', title: 'Arguments', text: 'Send objects.', scope: 'global', model: ' qwen/q ' });
    expect(made.data).toMatchObject({ model: 'qwen/q' });

    const renamed = await axios.put(harness.url(`/api/memories/${made.data.id}`), { title: 'Arguments as objects' });
    expect(renamed.data).toMatchObject({ title: 'Arguments as objects', model: 'qwen/q' });

    const everyone = await axios.put(harness.url(`/api/memories/${made.data.id}`), { model: null });
    expect(everyone.data).not.toHaveProperty('model');
    expect((await harness.db.getMemories(TEST_USER.id))[0]).not.toHaveProperty('model');
  });

  it('lists memories without the notes learned about tools, which live on the tools\' pages', async () => {
    await harness.db.saveMemory({ id: 'n1', ownerId: TEST_USER.id, category: 'tool_note', tool: 'start_task', status: 'active', title: 'Claim', text: 'Claim first.', createdAt: 'a', updatedAt: 'a' });
    await axios.post(harness.url('/api/memories'), { category: 'lessons_learned', title: 'Kept', text: 'A lesson.', scope: 'global' });
    expect((await axios.get(harness.url('/api/memories'))).data.map((memory: { title: string }) => memory.title)).toEqual(['Kept']);
  });

  it('keeps one for every model when no model is given', async () => {
    const made = await axios.post(harness.url('/api/memories'), { category: 'environment_facts', title: 'DNS', text: 'Cloudflare.', scope: 'global', model: '' });
    expect(made.data).not.toHaveProperty('model');
  });
});
