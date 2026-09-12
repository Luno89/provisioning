import { describe, it, expect, afterAll } from 'vitest';
import type { Socket } from 'socket.io';
import { localAgentsRouter } from './local-agents.js';
import { mountRouter, type Harness, TEST_USER } from './test-harness.js';
import type { Database } from '../lib/db-interface.js';
import { decryptValue } from '../lib/crypto.js';
import { registerDevice } from '../lib/local-agent-registry.js';
import { ProjectRepoService } from '../services/ProjectRepoService.js';
import type { GiteaService } from '../services/GiteaService.js';

const JWT_SECRET = 'test-secret';

const harness: Harness = await mountRouter({
  prefix: '/api/mesh/local-agents',
  router: (db: Database) => localAgentsRouter({
    db, jwtSecret: JWT_SECRET,
    projects: new ProjectRepoService(db, {} as GiteaService, JWT_SECRET),
  }),
});

afterAll(async () => { await harness.close(); });

describe('POST /api/mesh/local-agents', () => {
  it('registers a device, returning the token once and encrypting it at rest', async () => {
    const res = await fetch(harness.url('/api/mesh/local-agents'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'My Laptop', rootDir: '/home/me/koala-work' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; name: string; rootDir: string; token: string; projectId?: string };
    expect(body.name).toBe('My Laptop');
    expect(body.token).toBeTruthy();

    const [saved] = (await harness.db.getLocalAgentDevices()).filter((d) => d.id === body.id);
    expect(saved).toBeDefined();
    expect(saved!.tokenEnc).not.toBe(body.token);
    expect(decryptValue(saved!.tokenEnc, JWT_SECRET)).toBe(body.token);
    expect(saved!.ownerId).toBe(TEST_USER.id);

    expect(body.projectId).toBeTruthy();
    const project = (await harness.db.getProjects()).find((p) => p.id === body.projectId);
    expect(project?.name).toBe('My Laptop - koala-work');
    expect(project?.giteaOwner).toBeFalsy();
    expect(project?.executionTarget).toEqual({ kind: 'local-device', deviceId: body.id });
  });

  it('requires a name and a rootDir', async () => {
    const noName = await fetch(harness.url('/api/mesh/local-agents'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootDir: '/x' }),
    });
    expect(noName.status).toBe(400);

    const noRoot = await fetch(harness.url('/api/mesh/local-agents'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(noRoot.status).toBe(400);
  });
});

describe('GET /api/mesh/local-agents', () => {
  it('lists only the requesting user\'s own devices, with online status', async () => {
    await harness.db.saveLocalAgentDevice({
      id: 'dev-mine', ownerId: TEST_USER.id, name: 'Mine', rootDir: '/x',
      tokenEnc: 'irrelevant', createdAt: '2026-01-01T00:00:00Z',
    });
    await harness.db.saveLocalAgentDevice({
      id: 'dev-theirs', ownerId: 'someone-else', name: 'Theirs', rootDir: '/y',
      tokenEnc: 'irrelevant', createdAt: '2026-01-01T00:00:00Z',
    });

    const res = await fetch(harness.url('/api/mesh/local-agents'));
    const body = await res.json() as any[];

    expect(body.some((d) => d.id === 'dev-mine')).toBe(true);
    expect(body.some((d) => d.id === 'dev-theirs')).toBe(false);
    const mine = body.find((d) => d.id === 'dev-mine');
    expect(mine.online).toBe(false);
    expect(mine.tokenEnc).toBeUndefined();
  });

  it('reports whether a connected device is running in container mode', async () => {
    await harness.db.saveLocalAgentDevice({
      id: 'dev-container', ownerId: TEST_USER.id, name: 'Docker box', rootDir: '/x',
      tokenEnc: 'irrelevant', createdAt: '2026-01-01T00:00:00Z',
    });
    registerDevice('dev-container', TEST_USER.id, '/x', {} as Socket, true);

    const res = await fetch(harness.url('/api/mesh/local-agents'));
    const body = await res.json() as any[];
    const device = body.find((d) => d.id === 'dev-container');

    expect(device.online).toBe(true);
    expect(device.containerMode).toBe(true);
  });
});

describe('DELETE /api/mesh/local-agents/:id', () => {
  it('revokes a device the user owns', async () => {
    await harness.db.saveLocalAgentDevice({
      id: 'dev-delete-me', ownerId: TEST_USER.id, name: 'Bye', rootDir: '/x',
      tokenEnc: 'irrelevant', createdAt: '2026-01-01T00:00:00Z',
    });

    const res = await fetch(harness.url('/api/mesh/local-agents/dev-delete-me'), { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await harness.db.getLocalAgentDevices()).some((d) => d.id === 'dev-delete-me')).toBe(false);
  });

  it('refuses to revoke a device belonging to someone else', async () => {
    await harness.db.saveLocalAgentDevice({
      id: 'dev-not-mine', ownerId: 'someone-else', name: 'Not mine', rootDir: '/x',
      tokenEnc: 'irrelevant', createdAt: '2026-01-01T00:00:00Z',
    });

    const res = await fetch(harness.url('/api/mesh/local-agents/dev-not-mine'), { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect((await harness.db.getLocalAgentDevices()).some((d) => d.id === 'dev-not-mine')).toBe(true);
  });
});
