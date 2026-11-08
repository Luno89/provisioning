import { describe, expect, it } from 'vitest';
import { pullBetween, pullsFrom } from './gitea-answers.js';

describe("reading Gitea's answers", () => {
  it('reads pull requests and finds the one between two branches', () => {
    const pulls = pullsFrom([
      { number: 3, title: 'Land a', head: { ref: 'a' }, base: { ref: 'main' }, state: 'open', merged: false },
      { number: 4, title: 'Land b', head: { ref: 'b' }, base: { ref: 'main' }, state: 'closed', merged: true },
      { title: 'no number' },
    ]);
    expect(pulls).toEqual([
      { number: 3, title: 'Land a', head: 'a', base: 'main', state: 'open', merged: false },
      { number: 4, title: 'Land b', head: 'b', base: 'main', state: 'closed', merged: true },
    ]);
    expect(pullBetween(pulls, 'b', 'main')).toBe(4);
    expect(pullBetween(pulls, 'c', 'main')).toBeUndefined();
  });

  it('refuses an answer that is not a list', () => {
    expect(() => pullsFrom({ message: 'oops' })).toThrow(/not a list/);
  });
});
