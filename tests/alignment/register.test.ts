import { describe, expect, it } from 'vitest';
import type { Decision } from './decisions.js';
import { DECISIONS } from './decisions.js';
import { registerProblems, sourceOf } from './register.js';
import type { Said } from './said.js';

const said: Said[] = [
  { at: '2026-11-06T05:19:39.000Z', session: 's', how: 'typed', text: '1 - there was some reason that k3d was better if you didn\'t need the passthrough, so users who don\'t need gpu workflows might pick k3d. 2 - we can remove mock cloud mode' },
  { at: '2026-11-04T03:51:10.000Z', session: 's', how: 'answer', question: 'On a Mac, what provides the Linux VM and the cluster (which can also hold Koala)?', text: 'Colima with k3s (Recommended)' },
];

const decision = (overrides: Partial<Decision>): Decision => ({
  id: 'k3d', subject: 'k3d', terms: ['k3d'], steps: [], reading: 'reading',
  words: [{ at: '2026-11-06T05:19', text: 'users who don\'t need gpu workflows might pick k3d' }],
  ...overrides,
});

describe('the decision register, held to what the owner said', () => {
  it('finds a quote that is part of a longer message, said in that minute, whatever its spacing', () => {
    expect(sourceOf({ at: '2026-11-06T05:19', text: 'users who don\'t   need gpu workflows\nmight pick k3d' }, said)).toBe(said[0]);
  });

  it('finds an answer only with the question it answered', () => {
    expect(sourceOf({ at: '2026-11-04T03:51', asked: 'On a Mac, what provides the Linux VM', text: 'Colima with k3s (Recommended)' }, said)).toBe(said[1]);
    expect(sourceOf({ at: '2026-11-04T03:51', asked: 'Which inference servers?', text: 'Colima with k3s (Recommended)' }, said)).toBeUndefined();
    expect(sourceOf({ at: '2026-11-04T03:51', text: 'Colima with k3s (Recommended)' }, said)).toBeUndefined();
  });

  it('passes a register whose every quote was said, and names each one that was not', () => {
    expect(registerProblems([decision({})], said)).toEqual([]);
    expect(registerProblems([decision({ words: [{ at: '2026-11-06T05:19', text: 'users who don\'t need sudo might pick k3d' }] })], said))
      .toEqual(['k3d: "users who don\'t need sudo might pick k3d" is not what the owner said at 2026-11-06T05:19']);
    expect(registerProblems([decision({ words: [{ at: '2026-11-06T05:20', text: 'might pick k3d' }] })], said)).toHaveLength(1);
  });

  it('holds a replaced decision\'s words to the transcripts too', () => {
    const replaced = decision({ replaced: [{ words: { at: '2026-11-04T03:51', asked: 'On a Mac', text: 'Docker Desktop' }, by: 'later words' }] });
    expect(registerProblems([replaced], said)).toEqual(['k3d: "Docker Desktop" is not what the owner said at 2026-11-04T03:51']);
  });

  it('refuses a register with a repeated id, a decision with no words or no terms', () => {
    expect(registerProblems([decision({}), decision({})], said)).toEqual(['k3d: the id is used twice']);
    expect(registerProblems([decision({ words: [] })], said)).toEqual(['k3d: no words of the owner\'s behind it']);
    expect(registerProblems([decision({ terms: [] })], said)).toEqual(['k3d: no terms, so drift cannot find what it is about']);
  });

  it('keeps every shipped decision\'s id unique and gives each words, terms and a reading', () => {
    expect(new Set(DECISIONS.map((entry) => entry.id)).size).toBe(DECISIONS.length);
    for (const entry of DECISIONS) {
      expect(entry.words.length, entry.id).toBeGreaterThan(0);
      expect(entry.terms.length, entry.id).toBeGreaterThan(0);
      expect(entry.reading.length, entry.id).toBeGreaterThan(0);
    }
  });
});
