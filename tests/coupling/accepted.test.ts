import { describe, expect, it } from 'vitest';
import { acceptedUntested, UNTESTED_LIST } from './accepted.js';

describe('taking today\'s untested functions into the list that only shrinks', () => {
  const list = { 'a.ts#save': 1, 'b.ts#load': 2 };
  const now = { 'a.ts#save': 1, 'b.ts#load': 2, 'c.ts#new': 1, 'd.ts#new': 1 };

  it('takes them only when the register grants growth from the list\'s count up to at least today\'s', () => {
    expect(acceptedUntested(list, now, [{ path: UNTESTED_LIST, rule: '*', from: 3, to: 5 }])).toEqual({ list: now });
  });

  it('takes them with no yes when the list\'s count does not grow, since the list is held to its count', () => {
    const shrunk = { 'c.ts#new': 1, 'd.ts#new': 1 };
    expect(acceptedUntested(list, shrunk, [])).toEqual({ list: shrunk });
  });

  it('refuses with why when no yes is recorded, the yes names another count, or today\'s count is past it', () => {
    expect(acceptedUntested(list, now, [])).toEqual({ refused: 'the untested list would grow from 3 to 5, which needs the owner\'s yes recorded in the decisions register' });
    expect(acceptedUntested(list, now, [{ path: UNTESTED_LIST, rule: '*', from: 2, to: 5 }])).toEqual({ refused: 'the untested list would grow from 3 to 5, which needs the owner\'s yes recorded in the decisions register' });
    expect(acceptedUntested(list, now, [{ path: UNTESTED_LIST, rule: '*', from: 3, to: 4 }])).toEqual({ refused: 'the untested list would grow from 3 to 5, past the 4 the register allows' });
  });
});
