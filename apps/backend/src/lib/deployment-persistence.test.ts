/**
 * `saveDeploymentInfo` rebuilds the record field-by-field from an allowlist rather than spreading
 * what it was given. Anything not enumerated there is dropped on write — silently, with no type
 * error, because the argument genuinely does have the field.
 *
 * ── HOW THIS FAILS IN PRACTICE ──
 * Caught live, on the first real deploy of Crawl4AI. The api_token was minted, threaded through the
 * bridge, written to the record, and gone by the time anything read it back. The construct then
 * generated its own, so the pod held a credential the backend could not know — and the agent
 * quietly fell back to tag-stripping with nothing in the logs to say why. The explicitly-supplied
 * memory limit disappeared the same way.
 *
 * Round-tripping every field the harness depends on is the cheapest guard: adding a field to the
 * type is not enough, and nothing else in the stack will tell you.
 */
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
    // The token especially: without it there is no way into the service at all, and its absence
    // is indistinguishable from the service being down.
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
    // The transition is a second full write. This is where the vllm/tabby config group was once
    // wiped wholesale, and the shape of that bug is identical.
    const db = new MemoryDB();
    await db.saveDeploymentInfo({ ...base, appType: 'crawl4ai', crawl4aiApiToken: 'the-token' });

    const [mid] = await db.getDeployments();
    await db.saveDeploymentInfo({ ...mid!, status: 'running' });

    const [after] = await db.getDeployments();
    expect(after?.crawl4aiApiToken).toBe('the-token');
    expect(after?.status).toBe('running');
  });
});
