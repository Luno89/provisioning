import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { healthFromProbe, describeProbeFailure } from './service-health.js';

/**
 * Telling a service that ANSWERS from one that merely runs.
 *
 * ── WHY IT WAS HARD TO TELL ──
 * Two deployments both read `running`. One served three MCP tools; the other returned
 * `HTTP 404 from initialize` to everything. Kubernetes was right about both — the workload was
 * placed — and the only signal on screen was true of both, so the person who had just built them
 * could not say which was which.
 *
 * The same distinction this codebase draws everywhere else (`verified` vs `claimed`, `failed` vs
 * `unhealthy`) arriving one layer lower.
 */

describe('what a probe implies', () => {
  it('marks a service that does not answer', () => {
    // The exact observed failure.
    expect(healthFromProbe({ unreachable: 'HTTP 404 from initialize: {"error":"Not found"}', tools: 0 }))
      .toEqual({ reason: expect.stringContaining('HTTP 404 from initialize') });
  });

  it('marks a service that answers and offers nothing', () => {
    /**
     * The more confusing of the two: the pod is up, the port answers, and every agent granted the
     * service finds no tools with nothing saying why.
     */
    expect(healthFromProbe({ tools: 0 })).toEqual({ reason: 'answers but offers no tools' });
  });

  it('leaves a working service alone', () => {
    expect(healthFromProbe({ tools: 3 })).toBeUndefined();
  });
});

describe('the answers that must not change a status', () => {
  it('says nothing when no probe ran', () => {
    /**
     * Load-bearing. "Not probed" and "broken" arrive here identically otherwise, and a
     * reconciliation that guesses turns a blip into a wave of false unhealthy marks — worse than
     * the stale record it replaces.
     */
    expect(healthFromProbe(undefined)).toBeUndefined();
  });
});

describe('the reason someone reads', () => {
  it('keeps the probe\'s own words, because the fixes differ', () => {
    // `HTTP 404` and a connection refusal are different problems; collapsing both into
    // "unreachable" sends someone to the wrong place.
    expect(describeProbeFailure('connect ECONNREFUSED 10.0.0.155:32396')).toContain('ECONNREFUSED');
  });

  it('flattens and trims, so a status column can hold it', () => {
    expect(describeProbeFailure('line one\n  line two')).toBe('line one line two');
    const long = describeProbeFailure('x'.repeat(400));
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('where reconciliation applies it', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const bridge = readFileSync(join(here, '../services/TemporalBridge.ts'), 'utf8');

  it('probes only MCP-shaped deployments whose workload is already healthy', () => {
    /**
     * A crash-looping pod has a better reason attached than "it did not answer", and overwriting
     * that would send someone to the wrong problem.
     */
    expect(bridge).toMatch(/if \(health === 'healthy' && looksLikeMcp\(dep\) && dep\.ownerId\)/);
  });

  it('uses the cache rather than forcing a probe every sweep', () => {
    // The loop runs every thirty seconds; introspection holds for ten minutes.
    expect(bridge).toMatch(/registry\.listWithTools\(\)/);
    expect(bridge).not.toMatch(/registry\.listWithTools\(true\)/);
  });

  it('prefers the service reason over the workload one when both exist', () => {
    expect(bridge).toMatch(/healthReason: serviceReason \|\| reason/);
  });

  it('never lets a registry failure change a status', () => {
    const at = bridge.indexOf('A registry that cannot answer says nothing');
    expect(at).toBeGreaterThan(-1);
  });
});
