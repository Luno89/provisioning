import { describe, it, expect } from 'vitest';
import { generatedValue } from './secret-requests.js';

describe('a value the platform makes', () => {
  it('is letters and digits only, as long as asked, from the random bytes it is given', () => {
    let next = 0;
    const counting = (size: number) => Uint8Array.from({ length: size }, () => (next += 1) % 256);
    const value = generatedValue(counting, 40);
    expect(value).toMatch(/^[A-Za-z0-9]{40}$/);
  });

  it('never biases toward the first letters by using bytes past the last whole round of the alphabet', () => {
    const high = () => Uint8Array.from({ length: 64 }, (_, at) => (at === 63 ? 0 : 255));
    expect(generatedValue(high, 1)).toBe('A');
  });
});
