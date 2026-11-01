import { describe, expect, it } from 'vitest';
import { nodePortOf, pullBetween, pullsFrom } from './gitea-answers.js';

describe("reading Gitea's answers", () => {
  it('takes the named port of a service, else its first', () => {
    expect(nodePortOf({ spec: { ports: [{ name: 'ssh', nodePort: 30022 }, { name: 'http', nodePort: 30300 }] } }, 'http')).toBe(30300);
    expect(nodePortOf({ spec: { ports: [{ name: 'web', nodePort: 30400 }] } }, 'http')).toBe(30400);
    expect(nodePortOf({ spec: { ports: [{ name: 'http' }] } }, 'http')).toBeUndefined();
    expect(nodePortOf({ spec: {} }, 'http')).toBeUndefined();
    expect(nodePortOf('nothing', 'http')).toBeUndefined();
  });

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
