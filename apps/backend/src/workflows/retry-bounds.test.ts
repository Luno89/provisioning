import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ACTIVITY_ATTEMPTS, DESTROY_ATTEMPTS } from '../lib/activity-retry.js';

const here = dirname(fileURLToPath(import.meta.url));

const workflowFiles = readdirSync(here)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'index.ts');

describe('activity retry bounds', () => {
  it('finds the workflows, so this test is not vacuously passing', () => {
    expect(workflowFiles.length).toBeGreaterThanOrEqual(8);
  });

  it.each(workflowFiles)('%s bounds every activity it proxies', (file) => {
    const source = readFileSync(join(here, file), 'utf8');
    const proxies = [...source.matchAll(/proxyActivities</g)].length;
    if (proxies === 0) return;

    const bounded = [...source.matchAll(/retry:\s*\{|retry:\s*[A-Z_]+/g)].length;
    expect(bounded, `${file} proxies ${proxies} activities but bounds ${bounded}`).toBeGreaterThanOrEqual(proxies);
  });

  it('keeps the numbers small enough to surface a misconfiguration quickly', () => {
    expect(ACTIVITY_ATTEMPTS).toBeLessThanOrEqual(5);
    expect(ACTIVITY_ATTEMPTS).toBeGreaterThan(1);
  });

  it('lets a destroy try harder than ordinary work', () => {
    expect(DESTROY_ATTEMPTS).toBeGreaterThan(ACTIVITY_ATTEMPTS);
  });

  it('backs off rather than hammering the API server', async () => {
    const { ACTIVITY_RETRY } = await import('../lib/activity-retry.js');
    expect(ACTIVITY_RETRY.backoffCoefficient).toBeGreaterThan(1);
    expect(ACTIVITY_RETRY.initialInterval).not.toBe('1s');
  });
});
