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
    expect(routeProvider(providers, 'end-1')?.id).toBe('end-1');
  });

  it('falls back to the endpoint the pack names', () => {
    expect(routeProvider(providers, undefined, 'dep-1')?.id).toBe('dep-1');
  });

  it('lets an explicit request beat the pack, which is what a Lab variant needs', () => {
    expect(routeProvider(providers, 'end-1', 'dep-1')?.id).toBe('end-1');
  });

  it('refuses to guess when neither names one', () => {
    expect(routeProvider(providers)).toBeUndefined();
  });

  it('refuses rather than falling back when the named endpoint is gone', () => {
    expect(routeProvider(providers, 'deleted')).toBeUndefined();
    expect(routeProvider(providers, undefined, 'deleted')).toBeUndefined();
  });
});

describe('an account with exactly one endpoint', () => {
  const one = [providers[0]!];

  it('runs without anything naming it, because there is nothing to choose between', () => {
    // ModelService supplies the sole endpoint as the pack's; routeProvider itself never guesses.
    expect(routeProvider(one, undefined, one[0]!.id)?.id).toBe('dep-1');
  });
});
