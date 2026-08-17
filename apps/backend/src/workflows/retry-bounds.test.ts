import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ACTIVITY_ATTEMPTS, DESTROY_ATTEMPTS } from '../lib/activity-retry.js';

/**
 * Every activity gives up eventually.
 *
 * ── THE OUTAGE THIS PREVENTS ──
 * Temporal's default retry policy is UNLIMITED, and that default turned one bad Dockerfile into a
 * total outage. A project's Dockerfile copied `package.json` without `package-lock.json` and then
 * ran `npm ci`, which cannot work. `DeployAppActivity` retried it 54 times over ninety minutes,
 * holding the cluster worker's activity slot the whole time, and five pipeline runs queued behind
 * it never started — including the ones that would have replaced the broken image.
 *
 * Nothing crashed. One activity was retrying forever and starving the queue, and from outside the
 * system simply looked hung.
 *
 * ── WHY THIS TEST READS THE SOURCE ──
 * The failure mode is an OMISSION: a new workflow that forgets `retry` inherits unlimited and
 * nothing anywhere says so. Two workflows had bounded theirs deliberately and six had not, which is
 * how a decision in two files became an accident in six. A test that checked one workflow would not
 * have caught that; this one fails for the next file somebody adds.
 */

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

    /**
     * Counted rather than merely present: a file with three proxies and one `retry` is exactly the
     * shape of a half-done edit, and it is the two unbounded ones that would hang.
     */
    const bounded = [...source.matchAll(/retry:\s*\{|retry:\s*[A-Z_]+/g)].length;
    expect(bounded, `${file} proxies ${proxies} activities but bounds ${bounded}`).toBeGreaterThanOrEqual(proxies);
  });

  it('keeps the numbers small enough to surface a misconfiguration quickly', () => {
    /**
     * The question a retry answers is "was that transient?". A build whose Dockerfile cannot
     * succeed is not, and no number of attempts changes it — so the cap has to be low enough that
     * a real misconfiguration shows up in a minute rather than an afternoon.
     */
    expect(ACTIVITY_ATTEMPTS).toBeLessThanOrEqual(5);
    expect(ACTIVITY_ATTEMPTS).toBeGreaterThan(1);
  });

  it('lets a destroy try harder than ordinary work', () => {
    // A destroy that gives up leaves paid-for infrastructure running, so one more attempt costs
    // less than stopping does.
    expect(DESTROY_ATTEMPTS).toBeGreaterThan(ACTIVITY_ATTEMPTS);
  });

  it('backs off rather than hammering the API server', async () => {
    /**
     * The cap alone is not enough. 54 attempts at a one-second interval is a hot loop against the
     * Kubernetes API, and the first thing anybody does when a system looks hung is go looking for
     * whatever is hammering it.
     */
    const { ACTIVITY_RETRY } = await import('../lib/activity-retry.js');
    expect(ACTIVITY_RETRY.backoffCoefficient).toBeGreaterThan(1);
    expect(ACTIVITY_RETRY.initialInterval).not.toBe('1s');
  });
});
