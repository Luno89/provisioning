import { describe, expect, it } from 'vitest';
import { fieldsOf, textOf } from './request-fields.js';

describe('fieldsOf', () => {
  it('reads an object body as its fields', () => {
    expect(fieldsOf({ a: 1 })).toEqual({ a: 1 });
  });

  it('reads anything else as no fields', () => {
    expect(fieldsOf(undefined)).toEqual({});
    expect(fieldsOf(null)).toEqual({});
    expect(fieldsOf('text')).toEqual({});
    expect(fieldsOf([1, 2])).toEqual({});
  });
});

describe('textOf', () => {
  it('takes trimmed text and nothing blank or not text', () => {
    expect(textOf('  shop ')).toBe('shop');
    expect(textOf('   ')).toBeUndefined();
    expect(textOf(3)).toBeUndefined();
  });
});
