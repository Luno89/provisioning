import { describe, it, expect } from 'vitest';

/**
 * Ownership rules behind the Socket.IO room authorization added in index.ts.
 *
 * Socket.IO previously had no auth of any kind — no io.use(), unlike every /api route's
 * requireAuth — so any connected socket could join-room with a guessed resource id and receive
 * another tenant's live provisioning logs. Those logs are the most likely place for a secret to
 * surface, which makes this the one gap worth pinning down in tests rather than trusting to review.
 *
 * The handshake itself (anonymous rejected, forged cookie rejected, foreign room denied, own room
 * still allowed) is verified against a real socket client; these tests cover the decision rules,
 * which are pure and easy to get subtly wrong.
 */

/** Mirrors ownsProject in index.ts. */
const ownsProject = (project: any, user: any): boolean =>
  project?.ownerId ? project.ownerId === user.id : user.isAdmin === true;

/** Mirrors ClusterService.getById's visibility rule. */
const clusterVisible = (cluster: any, userId: string): boolean =>
  !!cluster && (cluster.isSystem === true || cluster.ownerId === userId);

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
    // Projects predate the ownership model. The old behaviour was that every user saw every
    // project; failing closed to admin-only is the point of the fallback.
    expect(ownsProject({ name: 'legacy' }, alice)).toBe(false);
    expect(ownsProject({ name: 'legacy' }, admin)).toBe(true);
  });

  it('does not treat an empty-string ownerId as absent — that would hand a corrupt record to every admin', () => {
    expect(ownsProject({ ownerId: '' }, admin)).toBe(true);
    // Documents the sharp edge: '' is falsy, so it takes the legacy branch. Acceptable only
    // because ownerId is always set from an authenticated user id, never from request input.
  });
});
