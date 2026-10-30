import { describe, expect, it } from 'vitest';
import { endsSocket } from './session-sockets.js';

const socket = { sessionId: 's1', personId: 'ann', sessionAt: 1_000 };

describe('which open connections a session ending closes', () => {
  it('closes the connections made with a session signed out of, and no other', () => {
    expect(endsSocket(socket, { kind: 'session', sessionId: 's1' })).toBe(true);
    expect(endsSocket(socket, { kind: 'session', sessionId: 's2' })).toBe(false);
  });

  it('closes a person\'s connections from sessions that began before their sessions were ended, leaving the session that ended them', () => {
    expect(endsSocket(socket, { kind: 'person', personId: 'ann', before: 2_000 })).toBe(true);
    expect(endsSocket(socket, { kind: 'person', personId: 'ann', before: 1_000 })).toBe(false);
    expect(endsSocket(socket, { kind: 'person', personId: 'bo', before: 2_000 })).toBe(false);
  });
});
