import { describe, it, expect } from 'vitest';
import { validateOverrides } from './tunables.js';

describe('which layer may set a model', () => {
  it('refuses a profile-wide model, and says where it belongs', () => {
    const refusal = validateOverrides({ model: 'dep-1' }, { layer: 'profile', models: ['dep-1'] });

    expect(refusal).toMatch(/cannot be set on the profile/i);
    expect(refusal).toMatch(/persona, pack or request/);
    expect(refusal).toMatch(/every persona in every project/i);
  });

  it('allows a persona to choose its own model', () => {
    expect(validateOverrides({ model: 'dep-1' }, { layer: 'persona', models: ['dep-1'] })).toBeNull();
  });

  it('STILL allows a variant to name a model', () => {
    expect(validateOverrides({ model: 'dep-2' }, { layer: 'request', models: ['dep-1', 'dep-2'] })).toBeNull();
  });

  it('leaves unrestricted knobs settable everywhere', () => {
    for (const layer of ['profile', 'persona', 'request'] as const) {
      expect(validateOverrides({ temperature: 0.7 }, { layer })).toBeNull();
    }
  });

  it('skips the layer rule when no layer is given', () => {
    expect(validateOverrides({ model: 'dep-1' })).toBeNull();
  });
});

describe('which values a model may take', () => {
  it('refuses an id that is not one of yours, listing the ones that are', () => {
    const refusal = validateOverrides({ model: 'someone-elses' }, { layer: 'persona', models: ['dep-1'] });

    expect(refusal).toMatch(/must be one of your models/i);
    expect(refusal).toMatch(/dep-1/);
  });

  it('says so plainly when you have no models at all', () => {
    expect(validateOverrides({ model: 'dep-1' }, { layer: 'persona', models: [] }))
      .toMatch(/no models deployed or registered/i);
  });

  it('skips the value check when the list could not be resolved', () => {
    expect(validateOverrides({ model: 'anything' }, { layer: 'persona' })).toBeNull();
  });

  it('still applies the ordinary type checks alongside', () => {
    expect(validateOverrides({ temperature: 'hot' as never }, { layer: 'persona' })).toMatch(/must be a number/i);
  });
});
