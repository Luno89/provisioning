import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../platform/lib/db-interface.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { callRouter, OPERATOR, PERSON, type CallingUser } from '../../monitoring/testing/call-router.js';
import type { ConsolidationReport } from '../lib/memory-consolidate.js';
import type { MemoryItem } from '../lib/memory-store.js';
import { memoriesRouter } from './memories.js';

const report: ConsolidationReport = { at: '2026-10-31T00:00:00.000Z', indexed: 0, deduped: 0, promoted: 0, decayed: 0, unreachable: 0, live: 3 };

let db: Database;
let lastConsolidation: ConsolidationReport | undefined;

const call = (path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', body?: unknown, user?: CallingUser) =>
  callRouter(memoriesRouter({ db, temporalBridge: lastConsolidation ? { lastConsolidation } : {} }), '/api/memories', { method, path, body, ...(user ? { user } : {}) });

const mine = () => db.memory.getMemories(PERSON.id);
const memory = (over: Partial<MemoryItem>): MemoryItem => ({
  id: 'm1', ownerId: PERSON.id, category: 'lessons_learned', scope: 'global', status: 'active', title: 'Arguments', text: 'Send objects.', createdAt: 'then', updatedAt: 'then', ...over,
});
const made = async (body: Record<string, unknown> = {}) =>
  (await call('/', 'POST', { category: 'lessons_learned', title: 'Arguments', text: 'Send objects.', scope: 'global', ...body })).body as MemoryItem;

beforeEach(() => {
  db = memoryDatabase();
  lastConsolidation = report;
});

describe('/api/memories', () => {
  it('shows the last consolidation, which covers everyone\'s memories, only to the operator', async () => {
    expect(await call('/consolidation')).toMatchObject({ status: 403, body: { error: 'Only the operator of this server can do that.' } });
    expect(await call('/consolidation', 'GET', undefined, OPERATOR)).toMatchObject({ status: 200, body: report });
  });

  it('shows nothing when no consolidation has run', async () => {
    lastConsolidation = undefined;
    expect(await call('/consolidation', 'GET', undefined, OPERATOR)).toMatchObject({ status: 200, body: null });
  });

  it('keeps a memory for one model when the person says which, and lets them make it hold for every model again', async () => {
    const item = await made({ model: ' qwen/q ' });
    expect(item).toMatchObject({ model: 'qwen/q', ownerId: PERSON.id, source: 'manual', status: 'active' });

    const renamed = await call(`/${item.id}`, 'PUT', { title: 'Arguments as objects' });
    expect(renamed.body).toMatchObject({ title: 'Arguments as objects', model: 'qwen/q' });

    const everyone = await call(`/${item.id}`, 'PUT', { model: null });
    expect(everyone.body).not.toHaveProperty('model');
    expect((await mine())[0]).not.toHaveProperty('model');
  });

  it('keeps one for every model when no model is given', async () => {
    expect(await made({ model: '', category: 'environment_facts' })).not.toHaveProperty('model');
  });

  it('lists the person\'s own memories without the notes learned about tools, which live on the tools\' pages', async () => {
    await db.memory.saveMemory(memory({ id: 'n1', category: 'tool_note', tool: 'start_task', title: 'Claim', text: 'Claim first.' }));
    await db.memory.saveMemory(memory({ id: 'theirs', ownerId: 'someone', title: 'Theirs' }));
    await made({ title: 'Kept' });
    expect(((await call('/')).body as MemoryItem[]).map((entry) => entry.title)).toEqual(['Kept']);
  });

  it('answers 201 with the memory made, stored for the project it names, and a pending one when asked', async () => {
    const answer = await call('/', 'POST', { category: 'lessons_learned', title: ' T ', text: ' X ', projectId: 'p1', recommendedScope: 'global', status: 'pending_review' });
    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({ title: 'T', text: 'X', projectId: 'p1', scope: 'project', recommendedScope: 'global', status: 'pending_review' });
    expect(await mine()).toHaveLength(1);
  });

  it('refuses a memory without its parts, a kind that does not exist, or one nothing could recall', async () => {
    expect(await call('/', 'POST', { category: 'lessons_learned', title: 'T' })).toMatchObject({ status: 400, body: { error: 'category, title, and text are required' } });
    expect(await call('/', 'POST', { category: 'gossip', title: 'T', text: 'X' })).toMatchObject({ status: 400, body: { error: 'gossip is not a kind of memory' } });
    expect(await mine()).toEqual([]);
  });

  it('refuses a scope or state of memory that does not exist rather than storing it', async () => {
    const item = await made();
    expect(await call(`/${item.id}`, 'PUT', { scope: 'everywhere' })).toMatchObject({ status: 400, body: { error: 'a memory\'s scope is project or global, not everywhere' } });
    expect((await call(`/${item.id}`, 'PUT', { status: 'archived' })).status).toBe(400);
    expect((await mine())[0]).toMatchObject({ scope: 'global', status: 'active' });
  });

  it('moves a memory to another project, or off its project', async () => {
    const item = await made({ projectId: 'p1', scope: 'project' });
    expect((await call(`/${item.id}`, 'PUT', { projectId: 'p2' })).body).toMatchObject({ projectId: 'p2' });
    expect((await call(`/${item.id}`, 'PUT', { projectId: null })).body).not.toHaveProperty('projectId');
  });

  it('approves a memory waiting for review, and makes one global', async () => {
    const item = await made({ status: 'pending_review', scope: 'project', projectId: 'p1' });
    expect((await call(`/${item.id}/approve`, 'PUT')).body).toMatchObject({ status: 'active' });
    expect((await call(`/${item.id}/promote`, 'PUT')).body).toMatchObject({ scope: 'global' });
    expect((await mine())[0]).toMatchObject({ status: 'active', scope: 'global' });
  });

  it('deletes a memory', async () => {
    const item = await made();
    expect(await call(`/${item.id}`, 'DELETE')).toMatchObject({ status: 200, body: { deleted: true } });
    expect(await mine()).toEqual([]);
  });

  it('answers 404 for a memory that is not the person\'s, whatever is done to it', async () => {
    await db.memory.saveMemory(memory({ id: 'theirs', ownerId: 'someone' }));
    for (const [method, path] of [['PUT', '/theirs/approve'], ['PUT', '/theirs/promote'], ['PUT', '/theirs'], ['DELETE', '/theirs']] as const) {
      expect(await call(path, method, {})).toMatchObject({ status: 404, body: { error: 'No such memory item' } });
    }
    expect((await db.memory.getMemories('someone'))).toHaveLength(1);
  });
});
