import { expect, it } from 'vitest';
import type { ClientSessions } from '../middleware/auth.js';

export interface SessionsWorld {
  sessions: ClientSessions;
  signIn(): Promise<string>;
}

export function clientSessionsContract(make: () => Promise<SessionsWorld>): void {
  it('takes no session from no token, or from one it never made', async () => {
    const { sessions } = await make();
    expect(sessions.verified(undefined)).toBeUndefined();
    expect(sessions.verified('')).toBeUndefined();
    expect(sessions.verified('not-a-session-it-made')).toBeUndefined();
  });

  it('takes the person a sign-in made from its token, with their claims, until a time still ahead', async () => {
    const world = await make();
    const session = world.sessions.verified(await world.signIn());
    expect([typeof session?.userId, typeof session?.email, typeof session?.sid]).toEqual(['string', 'string', 'string']);
    expect(session!.claims).toContainEqual({ role: 'person' });
    expect(session!.until).toBeGreaterThan(Date.now());
    expect(session!.sessionAt).toBeLessThanOrEqual(Date.now());
  });

  it('makes each sign-in a session of its own', async () => {
    const world = await make();
    const first = world.sessions.verified(await world.signIn())!;
    const second = world.sessions.verified(await world.signIn())!;
    expect(second.userId).toBe(first.userId);
    expect(second.sid).not.toBe(first.sid);
  });

  it('renews a live session as the same person and the same session', async () => {
    const world = await make();
    const session = world.sessions.verified(await world.signIn())!;
    const renewed = await world.sessions.renew(session);
    expect(renewed).not.toBe('ended');
    if (renewed !== 'kept' && renewed !== 'ended') {
      expect(renewed.session).toMatchObject({ userId: session.userId, sid: session.sid });
      expect(world.sessions.verified(renewed.token)).toMatchObject({ userId: session.userId, sid: session.sid });
    }
  });

  it('never renews a session once it is ended, and leaves the person\'s other sessions alone', async () => {
    const world = await make();
    const ended = world.sessions.verified(await world.signIn())!;
    const kept = world.sessions.verified(await world.signIn())!;
    await world.sessions.end(ended);
    expect(await world.sessions.renew(ended)).toBe('ended');
    expect(await world.sessions.renew(kept)).not.toBe('ended');
  });
}
