import { describe, expect, it } from 'vitest';
import { ignore } from './failures.js';

describe('ignoring a failure', () => {
  it('lets a failure go only when it says why', async () => {
    expect(await Promise.reject(new Error('gone already')).catch(ignore('the temp file may already be removed'))).toBeUndefined();
    expect(() => ignore('  ')).toThrow('say why the failure does not matter');
  });
});
