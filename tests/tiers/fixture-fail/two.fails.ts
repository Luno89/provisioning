import { describe, expect, it } from 'vitest';

describe('a run that fails', () => {
  it('fails on what it expected', () => {
    expect(2).toBe(3);
  });

  it('passes beside it', () => {
    expect(1).toBe(1);
  });
});
