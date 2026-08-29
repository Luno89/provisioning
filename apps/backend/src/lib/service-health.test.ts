import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { healthFromProbe, describeProbeFailure } from './service-health.js';

describe('what a probe implies', () => {
  it('marks a service that does not answer', () => {
    expect(healthFromProbe({ unreachable: 'HTTP 404 from initialize: {"error":"Not found"}', tools: 0 }))
      .toEqual({ reason: expect.stringContaining('HTTP 404 from initialize') });
  });

  it('marks a service that answers and offers nothing', () => {
    expect(healthFromProbe({ tools: 0 })).toEqual({ reason: 'answers but offers no tools' });
  });

  it('leaves a working service alone', () => {
    expect(healthFromProbe({ tools: 3 })).toBeUndefined();
  });
});

describe('the answers that must not change a status', () => {
  it('says nothing when no probe ran', () => {
    expect(healthFromProbe(undefined)).toBeUndefined();
  });
});

describe('the reason someone reads', () => {
  it('keeps the probe\'s own words, because the fixes differ', () => {
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
    expect(bridge).toMatch(/if \(health === 'healthy' && looksLikeMcp\(dep\) && dep\.ownerId\)/);
  });

  it('uses the cache rather than forcing a probe every sweep', () => {
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
