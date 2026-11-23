import { describe, expect, it } from 'vitest';

describe('a unit workload', () => {
  it('takes a second and a half', async () => {
    await new Promise((done) => setTimeout(done, 1_500));
    expect(1).toBe(1);
  });
});
