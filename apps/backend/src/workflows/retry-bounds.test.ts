import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';

const here = dirname(fileURLToPath(import.meta.url));

const proxyCount = (file: string): number => [...readFileSync(join(here, file), 'utf8').matchAll(/proxyActivities</g)].length;

const proxying = readdirSync(here)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'index.ts')
  .filter((f) => proxyCount(f) > 0);

describe('how activities are retried', () => {
  it('finds the workflows that proxy activities, so this test is not vacuously passing', () => {
    expect(proxying.length).toBeGreaterThanOrEqual(8);
  });

  it.each(proxying)('%s names the retry of every activity it proxies', (file) => {
    const source = readFileSync(join(here, file), 'utf8');
    const proxies = proxyCount(file);
    const bounded = [...source.matchAll(/retry:\s*\{|retry:\s*[A-Z_]+/g)].length;
    expect(bounded, `${file} proxies ${proxies} activities but bounds ${bounded}`).toBeGreaterThanOrEqual(proxies);
  });

  it('waits out a dependency that is down with no cap on the attempts, backing off to once a minute', () => {
    expect('maximumAttempts' in ACTIVITY_RETRY).toBe(false);
    expect(ACTIVITY_RETRY.backoffCoefficient).toBeGreaterThan(1);
    expect(ACTIVITY_RETRY).toMatchObject({ initialInterval: '5s', maximumInterval: '1m' });
  });

  it.each(['worker-cluster.ts', 'worker-engine.ts', 'worker-host.ts', 'engine-host/temporal/stream-worker.ts', '../../local-agent/src/engine-worker.ts'])(
    '%s classifies every activity\'s failure, so a misconfiguration or a bug fails at once and is never retried',
    (file) => {
      expect(readFileSync(join(here, '..', file), 'utf8')).toMatch(/activity: \[[^\]]*classifiedFailures\(\)/);
    },
  );
});
