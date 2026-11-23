import { describe, expect, it } from 'vitest';

describe('a component workload', () => {
  it('takes eleven seconds', async () => {
    await new Promise((done) => setTimeout(done, 11_000));
    expect(1).toBe(1);
  });
});
