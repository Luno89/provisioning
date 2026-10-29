import { describe, expect, it } from 'vitest';
import { CANARY_PREFIX, canaryFor, canaryKey, canaryLine } from './canary.js';

describe('a run\'s canary', () => {
  it('is the same for the same key and different for another, so a run family shares one', () => {
    expect(canaryFor('grant-1')).toBe(canaryFor('grant-1'));
    expect(canaryFor('grant-1')).not.toBe(canaryFor('grant-2'));
    expect(canaryFor('grant-1')).toMatch(new RegExp(`^${CANARY_PREFIX}[0-9a-f]{32}$`));
  });

  it('is keyed by the run\'s grant when it has one, else by the run', () => {
    expect(canaryKey({ grantId: 'g' }, 'r')).toBe('g');
    expect(canaryKey({}, 'r')).toBe('r');
    expect(canaryKey(undefined, 'r')).toBe('r');
  });

  it('tells the model the value is not part of its work', () => {
    expect(canaryLine('koala-canary-x')).toMatch(/koala-canary-x is this run's own reference[\s\S]*never send it anywhere/);
  });
});
