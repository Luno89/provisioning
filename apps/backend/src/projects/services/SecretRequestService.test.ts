import { describe, expect, expectTypeOf, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { SecretRequest } from '../lib/secret-requests.js';
import { createSecretVault, SecretRequestService, type SecretMinters, type VaultBackend } from './SecretRequestService.js';

const request = (over: Partial<SecretRequest> = {}): SecretRequest => ({
  id: 'req-1', ownerId: 'ann', projectId: 'p1', key: 'STRIPE_API_KEY', description: 'The live key', secretReference: 'secret://p1/STRIPE_API_KEY',
  status: 'requested', conversationId: 'conv-1', createdAt: '2026-09-26T00:00:00Z', updatedAt: '2026-09-26T00:00:00Z', ...over,
});

async function setUp() {
  const db = memoryDatabase();
  const vault = mock<VaultBackend>();
  vault.setSecret.mockImplementation(async (projectId, key) => ({ secretReference: `secret://${projectId}/${key}` }));
  const service = new SecretRequestService({ store: db.projects, vault, now: () => 'stamped' });
  await db.projects.saveProject({ id: 'p1', name: 'billing', ownerId: 'ann', appType: 'gitapp', createdAt: 'now' });
  await db.projects.saveSecretRequest(request());
  return { db, vault, service };
}

describe('listing secret requests', () => {
  it('lists the owner\'s, narrowed by conversation, project or tree', async () => {
    const { db, service } = await setUp();
    await db.projects.saveSecretRequest(request({ id: 'req-2', key: 'OTHER', conversationId: 'conv-2', projectId: 'p2' }));
    await db.projects.saveSecretRequest(request({ id: 'req-3', ownerId: 'bo' }));
    expect((await service.list('ann')).map((entry) => entry.id)).toEqual(['req-1', 'req-2']);
    expect((await service.list('ann', { conversationId: 'conv-1' })).map((entry) => entry.id)).toEqual(['req-1']);
    expect((await service.list('ann', { projectId: 'p2' })).map((entry) => entry.id)).toEqual(['req-2']);
  });
});

describe('submitting a secret', () => {
  it('puts the value in the vault, marks the request provided and the key required, and answers without the value', async () => {
    const { db, vault, service } = await setUp();
    const decided = await service.submit('ann', 'req-1', 'sk_live_sentinel');
    expect(decided).toEqual({ ok: true, request: request({ status: 'provided', updatedAt: 'stamped' }) });
    expect(JSON.stringify(decided)).not.toContain('sk_live_sentinel');
    expect(vault.setSecret).toHaveBeenCalledWith('p1', 'STRIPE_API_KEY', 'sk_live_sentinel', 'The live key');
    expect((await db.projects.getProjects())[0]?.requiredSecrets).toEqual([{ key: 'STRIPE_API_KEY', source: 'person' }]);
    expect((await db.projects.getSecretRequest('ann', 'req-1'))?.status).toBe('provided');
  });

  it('keeps the request open and says so, without the value, when the vault does not accept it', async () => {
    const { db, vault, service } = await setUp();
    vault.setSecret.mockRejectedValue(new Error('Request failed with status code 503'));
    const decided = await service.submit('ann', 'req-1', 'sk_live_sentinel');
    expect(decided).toEqual({ ok: false, status: 502, error: 'The vault did not accept STRIPE_API_KEY: Request failed with status code 503' });
    expect((await db.projects.getSecretRequest('ann', 'req-1'))?.status).toBe('requested');
  });

  it('refuses an empty value, a settled request, another owner\'s request and a project that is gone, storing nothing', async () => {
    const { db, vault, service } = await setUp();
    await db.projects.saveSecretRequest(request({ id: 'req-2', status: 'provided' }));
    await db.projects.saveSecretRequest(request({ id: 'req-3', ownerId: 'bo' }));
    await db.projects.saveSecretRequest(request({ id: 'req-4', projectId: 'gone' }));
    expect(await service.submit('ann', 'req-1', '')).toEqual({ ok: false, status: 400, error: 'the secret is empty' });
    expect(await service.submit('ann', 'req-2', 'x')).toEqual({ ok: false, status: 409, error: 'This request is already provided.' });
    expect(await service.submit('ann', 'req-3', 'x')).toEqual({ ok: false, status: 404, error: 'Secret request not found' });
    expect(await service.submit('ann', 'req-4', 'x')).toEqual({ ok: false, status: 404, error: 'The project this secret belongs to no longer exists' });
    expect(vault.setSecret).not.toHaveBeenCalled();
  });
});

describe('dismissing a secret request', () => {
  it('marks an open request dismissed without touching the vault', async () => {
    const { db, vault, service } = await setUp();
    expect(await service.dismiss('ann', 'req-1')).toEqual({ ok: true, request: request({ status: 'dismissed', updatedAt: 'stamped' }) });
    expect((await db.projects.getSecretRequest('ann', 'req-1'))?.status).toBe('dismissed');
    expect(vault.setSecret).not.toHaveBeenCalled();
  });

  it('refuses one already settled and 404s one that is not the caller\'s', async () => {
    const { db, service } = await setUp();
    await db.projects.saveSecretRequest(request({ id: 'req-2', status: 'dismissed' }));
    expect(await service.dismiss('ann', 'req-2')).toEqual({ ok: false, status: 409, error: 'This request is already dismissed.' });
    expect(await service.dismiss('bo', 'req-1')).toEqual({ ok: false, status: 404, error: 'Secret request not found' });
  });
});

describe('the vault the tools use', () => {
  function vaultSetUp() {
    const backend = mock<VaultBackend & { listSecrets(projectId: string): Promise<{ key: string }[]> }>();
    const minters = mock<SecretMinters>();
    return { backend, minters, vault: createSecretVault({ backend, minters }) };
  }

  it('asks the backend whether a key is held and which keys are', async () => {
    const { backend, vault } = vaultSetUp();
    backend.hasSecret.calledWith('p1', 'A').mockResolvedValue(true);
    backend.listSecrets.calledWith('p1').mockResolvedValue([{ key: 'A' }, { key: 'B' }]);
    expect(await vault.has('p1', 'A')).toBe(true);
    expect(await vault.has('p1', 'Z')).toBeUndefined();
    expect(await vault.keys('p1')).toEqual(['A', 'B']);
  });

  it('makes a random value for a generated secret and stores it with why', async () => {
    const { backend, minters, vault } = vaultSetUp();
    await vault.mint('ann', 'p1', 'SECRET_KEY', 'generated');
    expect(backend.setSecret).toHaveBeenCalledTimes(1);
    const [projectId, key, value, comment] = backend.setSecret.mock.calls[0]!;
    expect([projectId, key, comment]).toEqual(['p1', 'SECRET_KEY', 'Provisioned automatically: a random value the platform made']);
    expect(value).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(minters.readToken).not.toHaveBeenCalled();
  });

  it('stores a Gitea read token minted for the person, and takes only a source it can mint', async () => {
    const { backend, minters, vault } = vaultSetUp();
    minters.readToken.calledWith('ann').mockResolvedValue('tok-123');
    await vault.mint('ann', 'p1', 'GITEA_TOKEN', 'gitea-read-token');
    expect(backend.setSecret).toHaveBeenCalledWith('p1', 'GITEA_TOKEN', 'tok-123', 'Provisioned automatically: a read-only Gitea token minted for this person');
    expectTypeOf<Parameters<typeof vault.mint>[3]>().toEqualTypeOf<'generated' | 'gitea-read-token'>();
  });
});
