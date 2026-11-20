import { describe, expect, it } from 'vitest';
import { MECHANICS_CHECKS } from '../../apps/backend/src/eval/level2/mechanics.js';
import { e2eEnv, NOT_ON_AN_INSTANCE, shipChecks } from './e2e-env.js';

describe('the checks ship runs', () => {
  it('are every mechanics check but the ones named with why they cannot run on an instance, each of which exists', () => {
    const all = MECHANICS_CHECKS().map((scenario) => scenario.id);
    for (const id of Object.keys(NOT_ON_AN_INSTANCE)) expect(all).toContain(id);
    expect(shipChecks()).toEqual(all.filter((id) => !(id in NOT_ON_AN_INSTANCE)));
    expect(e2eEnv().CHECKS_LIVE_SCENARIOS!.split(',')).toEqual(shipChecks());
    expect(shipChecks()).toContain('mechanics-monitoring');
  });
});
