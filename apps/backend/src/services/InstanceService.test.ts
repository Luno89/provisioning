import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { InstanceService, JOIN_TOKEN_TTL_SECONDS, instanceIdFor } from './InstanceService.js';

const settings = {
  rootUrl: 'https://app.example.com',
  rootPublicKeys: () => ['PEM-1'],
  meshLoginServer: 'https://mesh.example.com',
  registry: '100.64.0.1:5001',
  imageTag: 'abc123',
  chartVersion: '0.1.0',
};
const mesh = { createPreAuthKey: async (ownerId: string) => ({ key: `pre-${ownerId}` }) };

let db: MemoryDB;
let now: Date;
let service: InstanceService;

beforeEach(async () => {
  db = new MemoryDB();
  await db.init();
  now = new Date('2026-10-02T12:00:00Z');
  service = new InstanceService(db, settings, mesh, () => now);
});

describe('bringing a user\'s own machine in as their instance', () => {
  it('gives the owner a one-line command, and the machine everything it needs, once', async () => {
    const { token, command } = await service.createJoinToken('u1');
    expect(command).toBe(`curl -fsSL https://app.example.com/install.sh | sudo sh -s -- ${token}`);
    expect(await service.mine('u1')).toMatchObject({ id: instanceIdFor('u1'), status: 'waiting' });

    const joined = await service.join(token, 'luno-desktop');
    expect(joined).toMatchObject({ ok: true, value: {
      instanceId: instanceIdFor('u1'), ownerId: 'u1', rootUrl: 'https://app.example.com', rootPublicKeys: 'PEM-1',
      meshLoginServer: 'https://mesh.example.com', preAuthKey: 'pre-u1', registry: '100.64.0.1:5001',
      image: '100.64.0.1:5001/nowrinkles/app', imageTag: 'abc123', chartUrl: 'https://app.example.com/api/instances/chart.tgz',
    } });
    expect(await service.mine('u1')).toMatchObject({ status: 'joined' });
    expect(await service.join(token, 'again')).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses a join command that has expired', async () => {
    const { token } = await service.createJoinToken('u1');
    now = new Date(now.getTime() + (JOIN_TOKEN_TTL_SECONDS + 1) * 1000);
    expect(await new InstanceService(db, settings, mesh, () => now).join(token, 'late')).toMatchObject({ ok: false, status: 401 });
  });

  it('keeps the machine\'s credential only as a hash, and answers only to it', async () => {
    const { token } = await service.createJoinToken('u1');
    const joined = await service.join(token, 'm');
    if (!joined.ok) throw new Error(joined.error);
    const id = joined.value.instanceId;

    const stored = (await db.getInstances('u1'))[0]!;
    expect(stored.credentialHash).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(joined.value.credential);

    expect(await service.release(id, joined.value.credential)).toMatchObject({ ok: true, value: { imageTag: 'abc123' } });
    expect(await service.release(id, 'guess')).toMatchObject({ ok: false, status: 401 });
    expect(await service.release('inst-someone-else', joined.value.credential)).toMatchObject({ ok: false, status: 401 });
  });

  it('records what the machine reports, and where the instance answers', async () => {
    const { token } = await service.createJoinToken('u1');
    const joined = await service.join(token, 'm');
    if (!joined.ok) throw new Error(joined.error);
    const { instanceId, credential } = joined.value;

    expect(await service.report(instanceId, credential, { status: 'ready', detail: 'Installed', url: 'http://100.64.0.7:30320/' })).toMatchObject({ ok: true });
    expect(await service.mine('u1')).toEqual({ id: instanceId, status: 'ready', detail: 'Installed', url: 'http://100.64.0.7:30320' });
    expect(await service.report(instanceId, credential, { status: 'exploded' })).toMatchObject({ ok: false, status: 400 });
    expect(await service.report(instanceId, credential, { status: 'ready', url: 'javascript:alert(1)' })).toMatchObject({ ok: false, status: 400 });
  });

  it('will not let a machine join a root with no mesh or no registry', async () => {
    const { token } = await service.createJoinToken('u1');
    const noRegistry = new InstanceService(db, { ...settings, registry: '' }, mesh, () => now);
    expect(await noRegistry.join(token, 'm')).toMatchObject({ ok: false, status: 503 });
  });
});
