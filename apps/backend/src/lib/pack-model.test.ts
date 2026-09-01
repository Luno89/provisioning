import { describe, it, expect } from 'vitest';
import { routeProvider } from './model-registry.js';
import type { ModelProvider } from './model-registry.js';

const providers = [
  { id: 'dep-1', name: 'Tabby', model: 'Qwen3-32B', source: 'deployment', kind: 'tabbyapi' },
  { id: 'end-1', name: 'Workstation', model: 'llama', source: 'endpoint' },
] as unknown as ModelProvider[];

/**
 * `routeProvider` used to return `providers[0]` when nothing named an endpoint, so a run silently
 * took whichever model happened to be listed first — and the run record said nothing about it. A
 * pack names its endpoint; nothing named anywhere is an error, not a quiet pick.
 */
describe('which engine a run reaches', () => {
  it('uses the endpoint the caller names', () => {
    expect(routeProvider(providers, 'end-1')?.provider.id).toBe('end-1');
  });

  it('falls back to the endpoint the pack names', () => {
    expect(routeProvider(providers, undefined, 'dep-1')?.provider.id).toBe('dep-1');
  });

  it('lets an explicit request beat the pack, which is what a Lab variant needs', () => {
    expect(routeProvider(providers, 'end-1', 'dep-1')?.provider.id).toBe('end-1');
  });

  it('refuses to guess when neither names one', () => {
    expect(routeProvider(providers)).toBeUndefined();
  });

  it('refuses rather than falling back when the named endpoint is gone', () => {
    expect(routeProvider(providers, 'deleted')).toBeUndefined();
    expect(routeProvider(providers, undefined, 'deleted')).toBeUndefined();
  });
});

describe('the account default, so switching engines is one edit not nine', () => {
  it('carries a pack that names no endpoint of its own', () => {
    const routed = routeProvider(providers, undefined, undefined, 'end-1');
    expect(routed?.provider.id).toBe('end-1');
    expect(routed?.source).toBe('global');
  });

  it('does not disturb a pack that pins its own engine, which a Lab arm does on purpose', () => {
    expect(routeProvider(providers, undefined, 'dep-1', 'end-1')?.provider.id).toBe('dep-1');
  });
});

/**
 * The override is a FLAG, not an edit to each pack. A pack keeps the engine it names either way,
 * so turning the override off returns every pack to its own — which overwriting them could not do.
 */
describe('the global override', () => {
  it('lets the account default beat a pack that names its own engine', () => {
    const routed = routeProvider(providers, undefined, 'dep-1', 'end-1', { overrideGlobal: true });
    expect(routed?.provider.id).toBe('end-1');
    expect(routed?.source).toBe('global');
  });

  it('leaves the pack winning when it is off, which is the default', () => {
    expect(routeProvider(providers, undefined, 'dep-1', 'end-1')?.provider.id).toBe('dep-1');
    expect(routeProvider(providers, undefined, 'dep-1', 'end-1', { overrideGlobal: false })?.provider.id)
      .toBe('dep-1');
  });

  it('returns the pack to its own engine the moment it is turned off', () => {
    const on = routeProvider(providers, undefined, 'dep-1', 'end-1', { overrideGlobal: true });
    const off = routeProvider(providers, undefined, 'dep-1', 'end-1', { overrideGlobal: false });
    expect(on?.provider.id).toBe('end-1');
    expect(off?.provider.id).toBe('dep-1');
  });

  it('still falls back to the pack when the override is on but no default is set', () => {
    const routed = routeProvider(providers, undefined, 'dep-1', undefined, { overrideGlobal: true });
    expect(routed?.provider.id).toBe('dep-1');
    expect(routed?.source).toBe('pack');
  });

  it('never beats an explicit request, which is a per-turn choice', () => {
    const routed = routeProvider(providers, 'dep-1', undefined, 'end-1', { overrideGlobal: true });
    expect(routed?.provider.id).toBe('dep-1');
    expect(routed?.source).toBe('request');
  });
});

describe('an account with exactly one endpoint', () => {
  const one = [providers[0]!];

  it('runs without anything naming it, because there is nothing to choose between', () => {
    // ModelService reaches the sole endpoint itself, as source 'sole'; routeProvider never guesses.
    expect(routeProvider(one, undefined, one[0]!.id)?.provider.id).toBe('dep-1');
  });
});
