import { describe, it, expect } from 'vitest';
import { validateClusterName, suggestClusterName, CLUSTER_NAME_MAX_LENGTH } from './cluster-name.js';

describe('validateClusterName', () => {
  it('rejects the name that actually broke a provision, with a usable suggestion', () => {
    // "VPS -test" reached CDKTF and failed with "Cannot create TerraformStack with id 'VPS -test'.
    // It contains a whitespace character" — deep inside a subprocess, minutes in.
    const r = validateClusterName('VPS -test');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('spaces');
    expect(r.suggestion).toBe('vps-test');
  });

  it('accepts ordinary names', () => {
    for (const n of ['prod', 'production-omega', 'cluster1', 'a', 'a1-b2-c3']) {
      expect(validateClusterName(n), n).toMatchObject({ ok: true });
    }
  });

  it('rejects anything that is not a valid RFC 1123 label', () => {
    // Each of these breaks a different downstream consumer: uppercase and underscores break
    // Kubernetes object names, leading/trailing hyphens break DNS labels.
    for (const n of ['MyCluster', 'my_cluster', '-leading', 'trailing-', 'has.dots', 'emoji🎉']) {
      expect(validateClusterName(n).ok, n).toBe(false);
    }
  });

  it('rejects an empty or non-string name', () => {
    expect(validateClusterName('').ok).toBe(false);
    expect(validateClusterName('   ').ok).toBe(false);
    expect(validateClusterName(undefined).ok).toBe(false);
    expect(validateClusterName(42).ok).toBe(false);
  });

  it('reserves the management cluster name', () => {
    const r = validateClusterName('provisioning-lunorica');
    expect(r.ok).toBe(false);
    // No suggestion here — every sanitisation of it is still the reserved name.
    expect(r.suggestion).toBeUndefined();
  });

  it('enforces the length budget', () => {
    expect(validateClusterName('a'.repeat(CLUSTER_NAME_MAX_LENGTH)).ok).toBe(true);
    const tooLong = validateClusterName('a'.repeat(CLUSTER_NAME_MAX_LENGTH + 1));
    expect(tooLong.ok).toBe(false);
    expect(tooLong.suggestion).toHaveLength(CLUSTER_NAME_MAX_LENGTH);
  });

  it('offers no suggestion when nothing can be salvaged', () => {
    expect(validateClusterName('!!!').suggestion).toBeUndefined();
  });
});

describe('suggestClusterName', () => {
  it('collapses runs of invalid characters rather than emitting a hyphen each', () => {
    expect(suggestClusterName('My  Cool___Cluster!!')).toBe('my-cool-cluster');
  });

  it('never returns a name that fails validation', () => {
    for (const raw of ['VPS -test', '  spaced  ', '__weird__', 'UPPER', 'a'.repeat(80), 'trailing---']) {
      const s = suggestClusterName(raw);
      if (s) expect(validateClusterName(s), `${raw} -> ${s}`).toMatchObject({ ok: true });
    }
  });
});
