import { describe, expect, it } from 'vitest';
import { devOnly } from './dependency-rule.js';

describe('what Koala runs, as ship and the dependency monitor both decide it', () => {
  it('is everything but a package only development uses, however the scanner or the inventory marks it', () => {
    expect(devOnly({ dependencyGroups: ['dev'] })).toBe(true);
    expect(devOnly({ dependencyGroups: ['prod', 'dev'] })).toBe(true);
    expect(devOnly({ scope: 'excluded' })).toBe(true);
    expect(devOnly({ dev: true })).toBe(true);
    expect(devOnly({ dependencyGroups: [] })).toBe(false);
    expect(devOnly({ scope: 'required', dev: false })).toBe(false);
    expect(devOnly({})).toBe(false);
  });
});
