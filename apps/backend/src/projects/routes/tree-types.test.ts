import { containing } from '../../platform/lib/test-matchers.js';
import { describe, expect, it } from 'vitest';
import { seedWorkspaceImages } from '../../engine/lib/workspace-image-seeds.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { TreeTypeSpec } from '../lib/tree-types.js';
import { seedTreeTypes } from '../lib/tree-types.js';
import { CALLER, del, get, put } from '../testing/route-call.js';
import { treeTypesRouter } from './tree-types.js';

const AGENTS = ['planner', 'leaf-worker', 'grove-runner', 'research'];

async function setUp(extra: { describe?: (ownerId: string, typeId: string) => Promise<string | undefined>; releaseProblem?: (ownerId: string, how: unknown) => Promise<string | null> } = {}) {
  const db = memoryDatabase();
  await seedTreeTypes(db.projects);
  await seedWorkspaceImages(db.engine);
  const router = treeTypesRouter({ db, agents: async () => AGENTS, ownNamespaces: async () => new Set(['shop-1a2b3c']), ...extra });
  const types = async () => (await get(router, '/')).body as TreeTypeSpec[];
  const shipped = async (id: string) => (await types()).find((type) => type.id === id)!;
  return { db, router, types, shipped };
}

describe('the tree-type catalogue', () => {
  it('serves the seeded catalogue', async () => {
    const { types } = await setUp();
    expect((await types()).length).toBeGreaterThan(0);
  });

  it('lists a built-in type once after the person edits it, showing their edit', async () => {
    const { router, types, shipped } = await setUp();
    const target = await shipped('mcp-server');
    expect((await put(router, '/mcp-server', { ...target, summary: 'Edited summary' })).status).toBe(200);
    const listed = (await types()).filter((type) => type.id === 'mcp-server');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ summary: 'Edited summary', ownerId: CALLER.id });
  });
});

describe('saving a tree type', () => {
  it('saves a network rule to one of the person\'s apps and refuses one to Koala\'s own services or an internal address', async () => {
    const { router, shipped } = await setUp();
    const target = await shipped('mcp-server');
    const save = (egress: unknown) => put(router, '/mcp-server', { ...target, egress });
    expect((await save([{ namespace: 'shop-1a2b3c', ports: [80] }])).status).toBe(200);
    expect((await save([{ namespace: 'gitea', ports: [3000] }])).body).toMatchObject({ error: containing('"gitea" is not one of your apps\' namespaces') });
    expect((await save([{ cidr: '192.168.1.0/24' }])).body).toMatchObject({ error: containing('inside 192.168.0.0/16, an internal range') });
  });

  it('keeps the agent a type names to grow its trees and refuses one that is not an agent', async () => {
    const { router, shipped } = await setUp();
    const paper = await shipped('research-paper');
    expect((await put(router, '/research-paper', { ...paper, agent: 'research' })).body).toMatchObject({ agent: 'research' });
    const unknown = await put(router, '/research-paper', { ...paper, agent: 'nobody' });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ error: containing('"nobody"') });
  });

  it('asks the release check about a release the type names and refuses what it refuses', async () => {
    const asked: unknown[] = [];
    const { router, shipped } = await setUp({ releaseProblem: async (ownerId, how) => { asked.push([ownerId, how]); return 'no such release agent'; } });
    const target = await shipped('api-service');
    const answer = await put(router, '/api-service', { ...target, release: { agent: 'release', app: 'odoo' } });
    expect(answer).toEqual({ status: 400, body: { error: 'no such release agent' } });
    expect(asked).toEqual([[CALLER.id, { agent: 'release', app: 'odoo' }]]);
  });
});

describe('describing a tree type', () => {
  it('serves the text for a type the describer knows and 404s any other', async () => {
    const { router } = await setUp({ describe: async (_ownerId, typeId) => (typeId === 'odoo-addons' ? 'Odoo addons (odoo-addons): …' : undefined) });
    expect(await get(router, '/odoo-addons/description')).toEqual({ status: 200, body: { text: 'Odoo addons (odoo-addons): …' } });
    expect(await get(router, '/nope/description')).toEqual({ status: 404, body: { error: 'There is no tree type "nope".' } });
  });

  it('says types are not described here when the server has no describer', async () => {
    const { router } = await setUp();
    expect(await get(router, '/odoo-addons/description')).toEqual({ status: 404, body: { error: 'Tree types are not described here' } });
  });
});

describe('deleting a tree type', () => {
  it('deletes a person\'s copy of a shipped type even while trees use it, since they fall back to the shipped one', async () => {
    const { db, router, types, shipped } = await setUp();
    const original = await shipped('api-service');
    await put(router, '/api-service', { ...original, summary: 'Mine' });
    await db.projects.saveTree({ id: 't1', ownerId: CALLER.id, name: 'shortener', type: 'api-service', createdAt: 'x', updatedAt: 'x' } as never);
    expect((await del(router, '/api-service')).status).toBe(200);
    const listed = (await types()).filter((type) => type.id === 'api-service');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.summary).toBe(original.summary);
    expect(listed[0]).not.toHaveProperty('ownerId');
  });

  it('refuses to delete a type of the person\'s own that trees still use, naming them', async () => {
    const { db, router, shipped } = await setUp();
    await put(router, '/my-own-kind', { ...(await shipped('api-service')), id: 'my-own-kind', label: 'Mine' });
    await db.projects.saveTree({ id: 't1', ownerId: CALLER.id, name: 'thing', type: 'my-own-kind', createdAt: 'x', updatedAt: 'x' } as never);
    expect(await del(router, '/my-own-kind')).toEqual({ status: 409, body: { error: '1 tree(s) still use this type: thing.' } });
  });

  it('deletes a type of the person\'s own that nothing uses', async () => {
    const { router, types, shipped } = await setUp();
    await put(router, '/my-own-kind', { ...(await shipped('api-service')), id: 'my-own-kind', label: 'Mine' });
    expect(await del(router, '/my-own-kind')).toEqual({ status: 200, body: { deleted: 'my-own-kind' } });
    expect((await types()).some((type) => type.id === 'my-own-kind')).toBe(false);
  });
});
