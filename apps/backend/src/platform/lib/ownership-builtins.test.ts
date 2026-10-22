import { describe, it, expect } from 'vitest';
import { withBuiltIns } from './ownership.js';

type Row = { ownerId?: string | undefined; slug: string; label: string };

const key = (r: Row) => r.slug;

describe('withBuiltIns', () => {
  const shipped: Row[] = [
    { slug: 'koala', label: 'shipped Koala' },
    { slug: 'builder', label: 'shipped Builder' },
  ];

  it('gives a user who has customised nothing exactly what ships', () => {
    expect(withBuiltIns(shipped, 'u1', key).map((r) => r.label))
      .toEqual(['shipped Koala', 'shipped Builder']);
  });

  it('hides a built-in behind the user\'s own version of it', () => {
    const rows = [...shipped, { ownerId: 'u1', slug: 'koala', label: 'my Koala' }];
    expect(withBuiltIns(rows, 'u1', key).map((r) => r.label))
      .toEqual(['my Koala', 'shipped Builder']);
  });

  it('keeps the shipped order, so an edit does not move the row', () => {
    const rows = [...shipped, { ownerId: 'u1', slug: 'builder', label: 'my Builder' }];
    expect(withBuiltIns(rows, 'u1', key).map((r) => r.slug)).toEqual(['koala', 'builder']);
  });

  it('shows one user nothing of another user\'s customisations', () => {
    const rows = [
      ...shipped,
      { ownerId: 'u1', slug: 'koala', label: 'u1 Koala' },
      { ownerId: 'u2', slug: 'koala', label: 'u2 Koala' },
      { ownerId: 'u2', slug: 'private', label: 'u2 only' },
    ];
    expect(withBuiltIns(rows, 'u1', key).map((r) => r.label)).toEqual(['u1 Koala', 'shipped Builder']);
    expect(withBuiltIns(rows, 'u2', key).map((r) => r.label)).toEqual(['u2 Koala', 'shipped Builder', 'u2 only']);
  });

  it('includes a user\'s own records that shadow nothing', () => {
    const rows = [...shipped, { ownerId: 'u1', slug: 'mine', label: 'wholly mine' }];
    expect(withBuiltIns(rows, 'u1', key).map((r) => r.slug)).toEqual(['koala', 'builder', 'mine']);
  });

  it('reveals the built-in again once the customisation is deleted', () => {
    const withEdit = [...shipped, { ownerId: 'u1', slug: 'koala', label: 'my Koala' }];
    const afterDelete = withEdit.filter((r) => r.ownerId !== 'u1');
    expect(withBuiltIns(afterDelete, 'u1', key).map((r) => r.label))
      .toEqual(['shipped Koala', 'shipped Builder']);
  });
});
