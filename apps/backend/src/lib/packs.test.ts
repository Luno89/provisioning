import { describe, it, expect } from 'vitest';
import { validatePack, packForLeaf } from './packs.js';
import type { PersonaPack } from '@koala/harness-types';

const pack = (over: Partial<PersonaPack> = {}): PersonaPack => ({
  id: 'pk1', ownerId: 'u1', slug: 'koala', name: 'Koala',
  personaId: 'p1', toolset: 'assistant', tools: [], permitted: ['read'],
  overrides: {}, createdAt: '', updatedAt: '', ...over,
});

describe('validatePack', () => {
  const personas = [{ id: 'p1' }, { id: 'p2' }];

  it('refuses a persona that does not exist', () => {
    // A pack pointing at nothing refuses mid-conversation, which is a bad place to learn that a
    // save was wrong. So it is refused at the write instead.
    expect(validatePack({ slug: 'a', name: 'A', personaId: 'gone', toolset: 'assistant' }, [], personas))
      .toMatch(/does not exist/i);
  });

  it('refuses a persona belonging to somebody else the same way as a missing one', () => {
    // `personas` arrives ownership-filtered, so "not yours" and "not there" are one answer —
    // distinguishing them tells a caller which ids are real.
    expect(validatePack({ slug: 'a', name: 'A', personaId: 'p9', toolset: 'assistant' }, [], personas))
      .toMatch(/does not exist/i);
  });

  it('refuses a slug that could not survive a URL', () => {
    for (const slug of ['Has Spaces', 'UPPER', 'trailing-', 'sym$bol']) {
      expect(validatePack({ slug, name: 'A', personaId: 'p1', toolset: 'assistant' }, [], personas), slug)
        .toMatch(/not a valid slug/i);
    }
  });

  it('refuses a duplicate slug, which is a route that cannot resolve', () => {
    const existing = [pack({ id: 'other', slug: 'koala' })];
    expect(validatePack({ slug: 'koala', name: 'A', personaId: 'p1', toolset: 'assistant' }, existing, personas))
      .toMatch(/already have a pack/i);
  });

  it('lets a pack keep its own slug when edited', () => {
    const existing = [pack({ id: 'pk1', slug: 'koala' })];
    expect(validatePack({ slug: 'koala', name: 'A', personaId: 'p1', toolset: 'assistant' }, existing, personas, 'pk1'))
      .toBeUndefined();
  });

  it('refuses an effect the gate would not recognise', () => {
    /**
     * The gate fails CLOSED on an unknown effect. So a typo does not read as a bad value — it reads
     * as every tool in the pack refusing, three layers from the cause.
     */
    expect(validatePack(
      { slug: 'a', name: 'A', personaId: 'p1', toolset: 'assistant', permitted: ['read', 'wrtie'] },
      [], personas,
    )).toMatch(/not an effect/i);
  });

  it('accepts the sandbox toolset, which is what a leaf pack runs as', () => {
    expect(validatePack({ slug: 'builder', name: 'Builder', personaId: 'p1', toolset: 'sandbox' }, [], personas))
      .toBeUndefined();
  });
});

describe('packForLeaf', () => {
  /**
   * Leaves predate packs — a leaf carries `personaId` because, when the board was built, a persona
   * WAS the whole environment. So resolution has to work for work planned before any of this, with
   * no migration and no dangling rows.
   */
  const koala = pack({ id: 'pk-koala', slug: 'koala', personaId: 'p1' });
  const builder = pack({ id: 'pk-builder', slug: 'builder', personaId: 'p2', toolset: 'sandbox' });
  const packs = [koala, builder];

  it('uses the pack a leaf names, by id or by slug', () => {
    expect(packForLeaf(packs, { packId: 'pk-builder' })).toBe(builder);
    expect(packForLeaf(packs, { packId: 'builder' })).toBe(builder);
  });

  it('falls back to the pack built for the persona the leaf was assigned', () => {
    // The case that covers every leaf created before packs existed.
    expect(packForLeaf(packs, { personaId: 'p2' })).toBe(builder);
  });

  it('prefers the named pack over the persona\'s, since naming one is the more specific choice', () => {
    expect(packForLeaf(packs, { packId: 'koala', personaId: 'p2' })).toBe(koala);
  });

  it('falls back to the persona when the named pack is gone', () => {
    // A deleted pack must not strand a leaf that is mid-flight; its persona still resolves one.
    expect(packForLeaf(packs, { packId: 'deleted', personaId: 'p2' })).toBe(builder);
  });

  it('uses the profile persona when the leaf names neither', () => {
    // What makes a Lab promotion mean anything: an adopted persona reaches unassigned work.
    expect(packForLeaf(packs, {}, 'p1')).toBe(koala);
  });

  it('returns nothing rather than guessing', () => {
    // The leaf then runs with no pack, which is exactly what it did before packs existed.
    expect(packForLeaf(packs, {})).toBeUndefined();
    expect(packForLeaf(packs, { personaId: 'nobody' })).toBeUndefined();
  });
});
