import { describe, it, expect } from 'vitest';
import { runLeafTool, type LeafToolContext } from './leaf-tool-runner.js';
import { MemoryDB } from './memory-db.js';
import type { AppSpec } from './app-spec.js';

/**
 * Declaring that a project depends on a running service.
 *
 * ── WHY THIS TOOL HAD TO EXIST ──
 * Everything else was in place — a planner could SEE mongo through `list_infrastructure`, the deploy
 * path could bind it, and the convention told an agent how to read it. Nothing could SAY that a
 * project should be able to connect to one. The declaration is the missing link, and it is also the
 * thing a person approves: `needs` is a property of the service, so every deploy binds the same
 * things and there is no per-deploy prompt to click through.
 */

const MONGO_SPEC: AppSpec = {
  id: 'mongo',
  image: 'mongo:7',
  ports: [{ name: 'mongo', port: 27017 }],
  env: [
    { name: 'U', fromSecret: 'mongo-root-username', generate: 'username' },
    { name: 'P', fromSecret: 'mongo-root-password', generate: 'password' },
  ],
  resources: { limits: { memory: '1Gi', cpu: '1' } },
};

const seeded = async () => {
  const db = new MemoryDB() as any;
  await db.saveBranch({ id: 'b1', ownerId: 'u1', createdAt: 'n', updatedAt: 'n' });
  await db.saveProject({ id: 'p1', ownerId: 'u1', name: 'github-mcp', giteaOwner: 'o', giteaRepo: 'r', appType: 'gitapp', createdAt: 'n' });
  await db.saveAppSpec({ id: 'mongo', spec: MONGO_SPEC, builtIn: false, createdAt: 'n', updatedAt: 'n' });
  await db.saveDeployment({ id: 'd1', name: 'spec-mongo', appType: 'mongo', status: 'running', ownerId: 'u1' });
  await db.saveDeployment({ id: 'd2', name: 'theirs', appType: 'mongo', status: 'running', ownerId: 'u2' });
  return db;
};

const ctx = (db: any): LeafToolContext => ({
  db, userId: 'u1', branchId: 'b1',
  webSearch: async () => [], fetchWebPage: async () => '',
  projects: { listForOwner: async (o: string) => (await db.getProjects()).filter((p: any) => p.ownerId === o) } as any,
});

const declare = async (db: any, args: unknown) =>
  JSON.parse(await runLeafTool(ctx(db), { name: 'add_project_dependency', arguments: JSON.stringify(args) }));

describe('declaring a dependency', () => {
  it('records it and says where the leaf will find it', async () => {
    const db = await seeded();
    const out = await declare(db, { projectId: 'p1', service: 'spec-mongo' });
    expect(out.added).toEqual({ service: 'spec-mongo', as: 'mongo', type: 'mongodb' });
    // The real paths, so the leaf writes code against them rather than guessing.
    expect(out.readAt).toBe('$SERVICE_BINDING_ROOT/mongo/');
    expect(out.files).toEqual(['type', 'host', 'port', 'username', 'password']);
    expect((await db.getProjects())[0].needs).toEqual([{ service: 'spec-mongo' }]);
  });

  it('tells the leaf not to hard-code or commit what it is given', async () => {
    const db = await seeded();
    expect((await declare(db, { projectId: 'p1', service: 'spec-mongo' })).note)
      .toMatch(/do not hard-code.*never commit/is);
  });

  it('takes a name, for two of the same kind', async () => {
    const db = await seeded();
    const out = await declare(db, { projectId: 'p1', service: 'spec-mongo', as: 'cache' });
    expect(out.readAt).toBe('$SERVICE_BINDING_ROOT/cache/');
    expect((await db.getProjects())[0].needs).toEqual([{ service: 'spec-mongo', as: 'cache' }]);
  });

  it('is idempotent — declaring twice does not duplicate', async () => {
    // A planner that re-reads its own board and calls again must not stack the same dependency.
    const db = await seeded();
    await declare(db, { projectId: 'p1', service: 'spec-mongo' });
    const again = await declare(db, { projectId: 'p1', service: 'spec-mongo' });
    expect(again.note).toMatch(/already depends on/);
    expect((await db.getProjects())[0].needs).toHaveLength(1);
  });
});

describe('what it refuses', () => {
  it('refuses a service belonging to someone else', async () => {
    /**
     * The same boundary `resolveBindings` enforces, applied HERE so the refusal reaches the model
     * while it can still act on it. The deploy path checks again, because a service can be
     * destroyed between declaring the dependency and using it.
     */
    const db = await seeded();
    const out = await declare(db, { projectId: 'p1', service: 'theirs' });
    expect(out.error).toMatch(/No service named "theirs"/);
    expect((await db.getProjects())[0].needs).toBeUndefined();
  });

  it('refuses a project belonging to someone else', async () => {
    const db = await seeded();
    await db.saveProject({ id: 'p2', ownerId: 'u2', name: 'not mine', giteaOwner: 'o', giteaRepo: 'r', appType: 'gitapp', createdAt: 'n' });
    expect((await declare(db, { projectId: 'p2', service: 'spec-mongo' })).error)
      .toMatch(/No project with that id/);
  });

  it('refuses a service that does not exist', async () => {
    const db = await seeded();
    expect((await declare(db, { projectId: 'p1', service: 'postgres' })).error).toMatch(/No service named/);
  });

  it('stores nothing when the binding cannot be resolved', async () => {
    // A declaration that cannot be honoured would fail at deploy time instead, which is later and
    // further from the decision.
    const db = await seeded();
    await declare(db, { projectId: 'p1', service: 'nope' });
    expect((await db.getProjects())[0].needs).toBeUndefined();
  });
});
