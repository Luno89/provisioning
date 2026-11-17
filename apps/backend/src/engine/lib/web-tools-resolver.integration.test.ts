import { describe, it, expect, vi } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { DeploymentMetadata } from '../../platform/index.js';
import { crawlEndpointWith, webToolsDepsFrom, type WebToolsDeps } from './web-tools-resolver.js';

const crawler = (id: string, ownerId: string | undefined): DeploymentMetadata => ({
  id, name: `crawler-${id}`, appType: 'crawl4ai', status: 'running', clusterId: 'c1', strategy: 'helm',
  crawl4aiApiToken: `token-${id}`,
  ...(ownerId ? { ownerId } : {}),
});

describe('the crawl4ai a person\'s crawl uses', () => {
  it('another person\'s or an ownerless running crawl4ai is never chosen', async () => {
    const db = await testDatabase();
    await db.infrastructure.saveDeployment(crawler('theirs', 'u2'));
    await db.infrastructure.saveDeployment(crawler('nobodys', undefined));
    const serviceUrl = vi.fn<WebToolsDeps['serviceUrl']>(async (_c, key) => `http://127.0.0.1:41000/${key}/`);
    const deps = { ...webToolsDepsFrom(db.infrastructure, { serviceUrl }), settings: {} };

    expect(await crawlEndpointWith(deps, 'u1')).toBeUndefined();
    expect(serviceUrl).not.toHaveBeenCalled();

    await db.infrastructure.saveDeployment(crawler('mine', 'u1'));
    expect(await crawlEndpointWith(deps, 'u1')).toEqual({ base: 'http://127.0.0.1:41000/crawl4ai-mine', token: 'token-mine' });
  });
});
