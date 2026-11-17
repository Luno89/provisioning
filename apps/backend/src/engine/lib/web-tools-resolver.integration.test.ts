import { describe, it, expect, vi } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { DeploymentMetadata } from '../../platform/index.js';
import { corpusEndpointsWith, webToolsDepsFrom, type WebToolsDeps } from './web-tools-resolver.js';

const index = (id: string, ownerId: string | undefined): DeploymentMetadata => ({
  id, name: `index-${id}`, appType: 'quickwit', status: 'running', clusterId: 'c1', strategy: 'helm',
  ...(ownerId ? { ownerId } : {}),
});

describe('the index a person\'s corpus uses', () => {
  it('another person\'s or an ownerless running Quickwit is never chosen', async () => {
    const db = await testDatabase();
    await db.infrastructure.saveDeployment(index('theirs', 'u2'));
    await db.infrastructure.saveDeployment(index('nobodys', undefined));
    const serviceUrl = vi.fn<WebToolsDeps['serviceUrl']>(async (_c, key) => `http://127.0.0.1:41000/${key}/`);
    const deps = { ...webToolsDepsFrom(db.infrastructure, { serviceUrl }), settings: {} };

    expect(await corpusEndpointsWith(deps, 'u1')).toEqual({});
    expect(serviceUrl).not.toHaveBeenCalled();

    await db.infrastructure.saveDeployment(index('mine', 'u1'));
    expect(await corpusEndpointsWith(deps, 'u1')).toEqual({ index: { base: 'http://127.0.0.1:41000/quickwit-mine' } });
  });
});
