import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../platform/lib/db-interface.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { HarnessUser } from '../../platform/routes/test-harness.js';
import { OPERATOR, PERSON, routesInProcess } from '../../platform/testing/routes.js';
import type { ConsolidationReport } from '../lib/memory-consolidate.js';
import type { MemoryItem } from '../lib/memory-store.js';
import { memoriesRouter } from './memories.js';
import { DependencyDownError } from '../../platform/lib/dependencies.js';

const report: ConsolidationReport = { at: '2026-10-31T00:00:00.000Z', indexed: 0, deduped: 0, promoted: 0, unreachable: 0, live: 3 };

let db: Database;
let lastConsolidation: ConsolidationReport | undefined;
let unindexed: string[][];
let indexRefuses: Error | undefined;

const call = async (path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', body?: unknown, user?: HarnessUser) => {
  const routes = await routesInProcess({ prefix: '/api/memories', router: () => memoriesRouter({ db, temporalBridge: lastConsolidation ? { lastConsolidation } : {}, unindex: async (_ownerId, ids) => { if (indexRefuses) throw indexRefuses; unindexed.push(ids); } }), user: user ?? PERSON, db });
  return routes.request(method, `/api/memories${path}`, { body });
};

const mine = () => db.memory.getMemories(PERSON.id);
const memory = (over: Partial<MemoryItem>): MemoryItem => ({
  id: 'm1', ownerId: PERSON.id, category: 'lessons_learned', scope: 'global', status: 'active', title: 'Arguments', text: 'Send objects.', createdAt: 'then', updatedAt: 'then', ...over,
});
const made = async (body: Record<string, unknown> = {}) =>
  (await call('/', 'POST', { category: 'lessons_learned', title: 'Arguments', text: 'Send objects.', scope: 'global', ...body })).data as MemoryItem;

beforeEach(() => {
  db = memoryDatabase();
  lastConsolidation = report;
  unindexed = [];
  indexRefuses = undefined;
});

describe('/api/memories', () => {
  it('shows the last consolidation, which covers everyone\'s memories, only to the operator', async () => {
    expect(await call('/consolidation')).toMatchObject({ status: 403, data: { error: 'Only the operator of this server can do that.' } });
    expect(await call('/consolidation', 'GET', undefined, OPERATOR)).toMatchObject({ status: 200, data: report });
  });

  it('shows nothing when no consolidation has run', async () => {
    lastConsolidation = undefined;
    expect(await call('/consolidation', 'GET', undefined, OPERATOR)).toMatchObject({ status: 200, data: null });
  });

  it('keeps a memory for one model when the person says which, and lets them make it hold for every model again', async () => {
    const item = await made({ model: ' qwen/q ' });
    expect(item).toMatchObject({ model: 'qwen/q', ownerId: PERSON.id, source: 'manual', status: 'active' });

    const renamed = await call(`/${item.id}`, 'PUT', { title: 'Arguments as objects' });
    expect(renamed.data).toMatchObject({ title: 'Arguments as objects', model: 'qwen/q' });

    const everyone = await call(`/${item.id}`, 'PUT', { model: null });
    expect(everyone.data).not.toHaveProperty('model');
    expect((await mine())[0]).not.toHaveProperty('model');
  });

  it('keeps one for every model when no model is given', async () => {
    expect(await made({ model: '', category: 'environment_facts' })).not.toHaveProperty('model');
  });

  it('lists the person\'s own memories without the notes learned about tools, which live on the tools\' pages', async () => {
    await db.memory.saveMemory(memory({ id: 'n1', category: 'tool_note', tool: 'start_task', title: 'Claim', text: 'Claim first.' }));
    await db.memory.saveMemory(memory({ id: 'theirs', ownerId: 'someone', title: 'Theirs' }));
    await made({ title: 'Kept' });
    expect(((await call('/')).data as MemoryItem[]).map((entry) => entry.title)).toEqual(['Kept']);
  });

  it('answers 201 with the memory made, stored for the project it names, and a pending one when asked', async () => {
    const answer = await call('/', 'POST', { category: 'lessons_learned', title: ' T ', text: ' X ', projectId: 'p1', recommendedScope: 'global', status: 'pending_review' });
    expect(answer.status).toBe(201);
    expect(answer.data).toMatchObject({ title: 'T', text: 'X', projectId: 'p1', scope: 'project', recommendedScope: 'global', status: 'pending_review' });
    expect(await mine()).toHaveLength(1);
  });

  it('refuses a memory without its parts, a kind that does not exist, or one nothing could recall', async () => {
    expect(await call('/', 'POST', { category: 'lessons_learned', title: 'T' })).toMatchObject({ status: 400, data: { error: 'category, title, and text are required' } });
    expect(await call('/', 'POST', { category: 'gossip', title: 'T', text: 'X' })).toMatchObject({ status: 400, data: { error: 'gossip is not a kind of memory' } });
    expect(await mine()).toEqual([]);
  });

  it('takes a deleted memory out of the index, so recall never finds it again', async () => {
    const item = await made();
    await call(`/${item.id}`, 'DELETE');
    expect(unindexed).toEqual([[item.id]]);
  });

  it('keeps a memory the index will not let go of, saying why', async () => {
    const item = await made();
    indexRefuses = new DependencyDownError('qdrant', '2026-11-21T10:00:00.000Z', 'its pod is not ready');
    expect(await call(`/${item.id}`, 'DELETE')).toMatchObject({ status: 503, data: { error: 'The memory index\'s meanings (Qdrant) isn\'t answering since 10:00 UTC: its pod is not ready' } });
    expect(await mine()).toHaveLength(1);
  });

  it('refuses a scope or state of memory that does not exist rather than storing it', async () => {
    const item = await made();
    expect(await call(`/${item.id}`, 'PUT', { scope: 'everywhere' })).toMatchObject({ status: 400, data: { error: 'a memory\'s scope is project or global, not everywhere' } });
    expect((await call(`/${item.id}`, 'PUT', { status: 'archived' })).status).toBe(400);
    expect((await mine())[0]).toMatchObject({ scope: 'global', status: 'active' });
  });

  it('moves a memory to another project, or off its project', async () => {
    const item = await made({ projectId: 'p1', scope: 'project' });
    expect((await call(`/${item.id}`, 'PUT', { projectId: 'p2' })).data).toMatchObject({ projectId: 'p2' });
    expect((await call(`/${item.id}`, 'PUT', { projectId: null })).data).not.toHaveProperty('projectId');
  });

  it('approves a memory waiting for review, and makes one global', async () => {
    const item = await made({ status: 'pending_review', scope: 'project', projectId: 'p1' });
    expect((await call(`/${item.id}/approve`, 'PUT')).data).toMatchObject({ status: 'active' });
    expect((await call(`/${item.id}/promote`, 'PUT')).data).toMatchObject({ scope: 'global' });
    expect((await mine())[0]).toMatchObject({ status: 'active', scope: 'global' });
  });

  it('deletes a memory', async () => {
    const item = await made();
    expect(await call(`/${item.id}`, 'DELETE')).toMatchObject({ status: 200, data: { deleted: true } });
    expect(await mine()).toEqual([]);
  });

  it('answers 404 for a memory that is not the person\'s, whatever is done to it', async () => {
    await db.memory.saveMemory(memory({ id: 'theirs', ownerId: 'someone' }));
    for (const [method, path] of [['PUT', '/theirs/approve'], ['PUT', '/theirs/promote'], ['PUT', '/theirs'], ['DELETE', '/theirs']] as const) {
      expect(await call(path, method, {})).toMatchObject({ status: 404, data: { error: 'No such memory item' } });
    }
    expect((await db.memory.getMemories('someone'))).toHaveLength(1);
  });
});
