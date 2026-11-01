import { fieldsOf, trimmedText } from './request-fields.js';
import { describe, expect, it } from 'vitest';

describe('reading a request body', () => {
  it('takes an object as its fields, and anything else as none', () => {
    expect(fieldsOf({ name: 'shop' })).toEqual({ name: 'shop' });
    expect(fieldsOf(undefined)).toEqual({});
    expect(fieldsOf(null)).toEqual({});
    expect(fieldsOf(['shop'])).toEqual({});
    expect(fieldsOf('shop')).toEqual({});
  });

  it('takes text with something in it, trimmed', () => {
    expect(trimmedText('  apps/one ')).toBe('apps/one');
    expect(trimmedText('   ')).toBeUndefined();
    expect(trimmedText(3)).toBeUndefined();
  });
});
