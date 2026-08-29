import { describe, it, expect } from 'vitest';
import { MemoryDB } from './memory-db.js';
import type { DeploymentMetadata } from './types.js';

const base = {
  id: 'd1', name: 'koala-crawler', clusterId: 'c1', strategy: 'native', status: 'deploying',
} as DeploymentMetadata;

describe('deployment fields survive a write', () => {
  it('keeps the credentials the agent needs to reach its own web services', async () => {
    const db = new MemoryDB();
    await db.saveDeploymentInfo({
      ...base,
      appType: 'crawl4ai',
      crawl4aiApiToken: 'the-token',
      crawl4aiMemoryLimit: '3Gi',
      crawl4aiShmSize: '512Mi',
    });

    const [saved] = await db.getDeployments();
    expect(saved?.crawl4aiApiToken).toBe('the-token');
    expect(saved?.crawl4aiMemoryLimit).toBe('3Gi');
    expect(saved?.crawl4aiShmSize).toBe('512Mi');
  });

  it('keeps the searxng settings', async () => {
    const db = new MemoryDB();
    await db.saveDeploymentInfo({
      ...base, name: 'koala-search', appType: 'searxng',
      searxngSecretKey: 'sk', searxngEngines: 'google,duckduckgo',
    });

    const [saved] = await db.getDeployments();
    expect(saved?.searxngSecretKey).toBe('sk');
    expect(saved?.searxngEngines).toBe('google,duckduckgo');
  });

  it('does not lose them on the deploying → running transition', async () => {
    const db = new MemoryDB();
    await db.saveDeploymentInfo({ ...base, appType: 'crawl4ai', crawl4aiApiToken: 'the-token' });

    const [mid] = await db.getDeployments();
    await db.saveDeploymentInfo({ ...mid!, status: 'running' });

    const [after] = await db.getDeployments();
    expect(after?.crawl4aiApiToken).toBe('the-token');
    expect(after?.status).toBe('running');
  });
});
