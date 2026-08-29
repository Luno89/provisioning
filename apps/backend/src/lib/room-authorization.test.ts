import { describe, it, expect } from 'vitest';
import { ownsProject, clusterVisible } from './ownership.js';

describe('cluster room visibility', () => {
  const alice = 'user-alice';

  it('lets an owner in', () => {
    expect(clusterVisible({ id: 'c1', ownerId: alice }, alice)).toBe(true);
  });

  it('keeps another tenant out', () => {
    expect(clusterVisible({ id: 'c1', ownerId: 'user-bob' }, alice)).toBe(false);
  });

  it('lets everyone see the shared system cluster, which has no owner by design', () => {
    expect(clusterVisible({ id: 'provisioning-lunorica', isSystem: true }, alice)).toBe(true);
  });

  it('treats an unknown id exactly like an unowned one, so a socket cannot probe which ids exist', () => {
    expect(clusterVisible(undefined, alice)).toBe(false);
    expect(clusterVisible({ id: 'c1', ownerId: 'user-bob' }, alice)).toBe(false);
  });
});

describe('project ownership', () => {
  const alice = { id: 'user-alice', isAdmin: false };
  const admin = { id: 'user-admin', isAdmin: true };

  it('lets an owner in', () => {
    expect(ownsProject({ ownerId: alice.id }, alice)).toBe(true);
  });

  it('keeps another tenant out — including an admin, since ownership is explicit once set', () => {
    expect(ownsProject({ ownerId: 'user-bob' }, alice)).toBe(false);
    expect(ownsProject({ ownerId: 'user-bob' }, admin)).toBe(false);
  });

  it('falls back to admin-only for legacy projects with no ownerId, rather than staying world-visible', () => {
    expect(ownsProject({ name: 'legacy' }, alice)).toBe(false);
    expect(ownsProject({ name: 'legacy' }, admin)).toBe(true);
  });

  it('does not treat an empty-string ownerId as absent — that would hand a corrupt record to every admin', () => {
    expect(ownsProject({ ownerId: '' }, admin)).toBe(true);
  });
});
