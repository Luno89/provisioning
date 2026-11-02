import { containing } from '../../platform/lib/test-matchers.js';
import { describe, expect, it } from 'vitest';
import { seedWorkspaceImages } from '../../engine/lib/workspace-image-seeds.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { TreeTypeSpec } from '../lib/tree-types.js';
import { seedTreeTypes } from '../lib/tree-types.js';
import { TEST_USER } from '../../platform/routes/test-harness.js';
import { routesInProcess, type RouteAnswer } from '../../platform/testing/routes.js';
import { treeTypesRouter } from './tree-types.js';

const AGENTS = ['planner', 'leaf-worker', 'grove-runner', 'research'];

const plain = ({ status, data }: RouteAnswer) => ({ status, body: data });

async function setUp(extra: { describe?: (ownerId: string, typeId: string) => Promise<string | undefined>; releaseProblem?: (ownerId: string, how: unknown) => Promise<string | null> } = {}) {
  const db = memoryDatabase();
  await seedTreeTypes(db.projects);
  await seedWorkspaceImages(db.engine);
  const router = treeTypesRouter({ db, agents: async () => AGENTS, ownNamespaces: async () => new Set(['shop-1a2b3c']), ...extra });
  const shipped = async (id: string) => (await types()).find((type) => type.id === id)!;
  const routes = await routesInProcess({ prefix: '/', router: () => router, db });
  const types = async () => (await routes.get('/')).data as TreeTypeSpec[];
  return { db, routes, types, shipped };
}

describe('the tree-type catalogue', () => {
  it('serves the seeded catalogue', async () => {
    const { types } = await setUp();
    expect((await types()).length).toBeGreaterThan(0);
  });

  it('lists a built-in type once after the person edits it, showing their edit', async () => {
    const { routes, types, shipped } = await setUp();
    const target = await shipped('mcp-server');
    expect((await routes.put('/mcp-server', { ...target, summary: 'Edited summary' })).status).toBe(200);
    const listed = (await types()).filter((type) => type.id === 'mcp-server');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ summary: 'Edited summary', ownerId: TEST_USER.id });
  });
});

describe('saving a tree type', () => {
  it('saves a network rule to one of the person\'s apps and refuses one to Koala\'s own services or an internal address', async () => {
    const { routes, shipped } = await setUp();
    const target = await shipped('mcp-server');
    const save = (egress: unknown) => routes.put('/mcp-server', { ...target, egress });
    expect((await save([{ namespace: 'shop-1a2b3c', ports: [80] }])).status).toBe(200);
    expect((await save([{ namespace: 'gitea', ports: [3000] }])).data).toMatchObject({ error: containing('"gitea" is not one of your apps\' namespaces') });
    expect((await save([{ cidr: '192.168.1.0/24' }])).data).toMatchObject({ error: containing('inside 192.168.0.0/16, an internal range') });
  });

  it('keeps the agent a type names to grow its trees and refuses one that is not an agent', async () => {
    const { routes, shipped } = await setUp();
    const paper = await shipped('research-paper');
    expect((await routes.put('/research-paper', { ...paper, agent: 'research' })).data).toMatchObject({ agent: 'research' });
    const unknown = await routes.put('/research-paper', { ...paper, agent: 'nobody' });
    expect(unknown.status).toBe(400);
    expect(unknown.data).toMatchObject({ error: containing('"nobody"') });
  });

  it('asks the release check about a release the type names and refuses what it refuses', async () => {
    const asked: unknown[] = [];
    const { routes, shipped } = await setUp({ releaseProblem: async (ownerId, how) => { asked.push([ownerId, how]); return 'no such release agent'; } });
    const target = await shipped('api-service');
    const answer = await routes.put('/api-service', { ...target, release: { agent: 'release', app: 'odoo' } });
    expect(plain(answer)).toEqual({ status: 400, body: { error: 'no such release agent' } });
    expect(asked).toEqual([[TEST_USER.id, { agent: 'release', app: 'odoo' }]]);
  });
});

describe('describing a tree type', () => {
  it('serves the text for a type the describer knows and 404s any other', async () => {
    const { routes } = await setUp({ describe: async (_ownerId, typeId) => (typeId === 'odoo-addons' ? 'Odoo addons (odoo-addons): …' : undefined) });
    expect(plain(await routes.get('/odoo-addons/description'))).toEqual({ status: 200, body: { text: 'Odoo addons (odoo-addons): …' } });
    expect(plain(await routes.get('/nope/description'))).toEqual({ status: 404, body: { error: 'There is no tree type "nope".' } });
  });

  it('says types are not described here when the server has no describer', async () => {
    const { routes } = await setUp();
    expect(plain(await routes.get('/odoo-addons/description'))).toEqual({ status: 404, body: { error: 'Tree types are not described here' } });
  });
});

describe('deleting a tree type', () => {
  it('deletes a person\'s copy of a shipped type even while trees use it, since they fall back to the shipped one', async () => {
    const { db, routes, types, shipped } = await setUp();
    const original = await shipped('api-service');
    await routes.put('/api-service', { ...original, summary: 'Mine' });
    await db.projects.saveTree({ id: 't1', ownerId: TEST_USER.id, name: 'shortener', type: 'api-service', createdAt: 'x', updatedAt: 'x' } as never);
    expect((await routes.delete('/api-service')).status).toBe(200);
    const listed = (await types()).filter((type) => type.id === 'api-service');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.summary).toBe(original.summary);
    expect(listed[0]).not.toHaveProperty('ownerId');
  });

  it('refuses to delete a type of the person\'s own that trees still use, naming them', async () => {
    const { db, routes, shipped } = await setUp();
    await routes.put('/my-own-kind', { ...(await shipped('api-service')), id: 'my-own-kind', label: 'Mine' });
    await db.projects.saveTree({ id: 't1', ownerId: TEST_USER.id, name: 'thing', type: 'my-own-kind', createdAt: 'x', updatedAt: 'x' } as never);
    expect(plain(await routes.delete('/my-own-kind'))).toEqual({ status: 409, body: { error: '1 tree(s) still use this type: thing.' } });
  });

  it('deletes a type of the person\'s own that nothing uses', async () => {
    const { routes, types, shipped } = await setUp();
    await routes.put('/my-own-kind', { ...(await shipped('api-service')), id: 'my-own-kind', label: 'Mine' });
    expect(plain(await routes.delete('/my-own-kind'))).toEqual({ status: 200, body: { deleted: 'my-own-kind' } });
    expect((await types()).some((type) => type.id === 'my-own-kind')).toBe(false);
  });
});
