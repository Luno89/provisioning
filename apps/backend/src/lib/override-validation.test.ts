import { describe, it, expect } from 'vitest';
import { validateOverrides } from './tunables.js';

/**
 * ── WHAT A SINGLE FIELD SHOULD NOT BE ABLE TO DO ──
 *
 * `resolveConfig` layers profile → persona → request, so a profile-level `model` repoints every
 * persona in every project at once. Since the context window now follows the model, it would also
 * silently resize every leaf's budget — a 131K engine swapped for a 32K one quarters the room every
 * run has, with nothing on screen saying so.
 *
 * And the value itself was never checked: `model` is `type: 'string'`, `choicesFrom` was a UI hint
 * the server ignored, so a stale id was accepted at write time and failed at every leaf afterwards.
 */

describe('which layer may set a model', () => {
  it('refuses a profile-wide model, and says where it belongs', () => {
    const refusal = validateOverrides({ model: 'dep-1' }, { layer: 'profile', models: ['dep-1'] });

    expect(refusal).toMatch(/cannot be set on the profile/i);
    expect(refusal).toMatch(/persona, pack or request/);
    // The reason, not just the rule — a refusal that does not explain gets worked around.
    expect(refusal).toMatch(/every persona in every project/i);
  });

  it('allows a persona to choose its own model', () => {
    // The intended way to run several models at once.
    expect(validateOverrides({ model: 'dep-1' }, { layer: 'persona', models: ['dep-1'] })).toBeNull();
  });

  it('STILL allows a variant to name a model', () => {
    /**
     * The regression guard for the Lab. `ExperimentService` passes variant overrides as the request
     * layer, and comparing two engines on one suite is the whole point of the model knob. If this
     * breaks, the restriction has been drawn in the wrong place.
     */
    expect(validateOverrides({ model: 'dep-2' }, { layer: 'request', models: ['dep-1', 'dep-2'] })).toBeNull();
  });

  it('leaves unrestricted knobs settable everywhere', () => {
    for (const layer of ['profile', 'persona', 'request'] as const) {
      expect(validateOverrides({ temperature: 0.7 }, { layer })).toBeNull();
    }
  });

  it('skips the layer rule when no layer is given', () => {
    // Callers that are not writing a layer keep the old behaviour rather than being refused.
    expect(validateOverrides({ model: 'dep-1' })).toBeNull();
  });
});

describe('which values a model may take', () => {
  it('refuses an id that is not one of yours, listing the ones that are', () => {
    // This used to be accepted and then fail at EVERY leaf, at run time, after a workspace had been
    // built, as "Model X not found".
    const refusal = validateOverrides({ model: 'someone-elses' }, { layer: 'persona', models: ['dep-1'] });

    expect(refusal).toMatch(/must be one of your models/i);
    expect(refusal).toMatch(/dep-1/);
  });

  it('says so plainly when you have no models at all', () => {
    expect(validateOverrides({ model: 'dep-1' }, { layer: 'persona', models: [] }))
      .toMatch(/no models deployed or registered/i);
  });

  it('skips the value check when the list could not be resolved', () => {
    /**
     * A model list that failed to load must not make the persona form unusable. Skipping is the
     * right failure here: the run-time resolve still refuses an unknown id, so this check is a
     * better error message rather than the only thing standing between a typo and a bad run.
     */
    expect(validateOverrides({ model: 'anything' }, { layer: 'persona' })).toBeNull();
  });

  it('still applies the ordinary type checks alongside', () => {
    expect(validateOverrides({ temperature: 'hot' as never }, { layer: 'persona' })).toMatch(/must be a number/i);
  });
});
