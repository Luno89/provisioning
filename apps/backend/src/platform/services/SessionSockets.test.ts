import { describe, expect, it } from 'vitest';
import { SessionSockets } from './SessionSockets.js';

const fake = (id: string) => {
  const socket = { id, closed: 0, disconnect(close?: boolean) { if (close) socket.closed += 1; } };
  return socket;
};

describe('the open connections and the sessions they were made with', () => {
  it('closes each connection once, forgets it, and forgets one that left by itself', () => {
    const sockets = new SessionSockets();
    const one = fake('a');
    const two = fake('b');
    sockets.track(one, { sessionId: 's1', personId: 'ann', sessionAt: 1 });
    sockets.track(two, { sessionId: 's2', personId: 'ann', sessionAt: 5 });
    expect(sockets.end({ kind: 'session', sessionId: 's1' })).toBe(1);
    expect(sockets.end({ kind: 'session', sessionId: 's1' })).toBe(0);
    expect(one.closed).toBe(1);
    sockets.forget('b');
    expect(sockets.end({ kind: 'person', personId: 'ann', before: 10 })).toBe(0);
    expect(two.closed).toBe(0);
  });
});

describe('how many connections are open', () => {
  it('counts the ones tracked and not the ones closed or forgotten', () => {
    const sockets = new SessionSockets();
    expect(sockets.size).toBe(0);
    sockets.track(fake('a'), { sessionId: 's1', personId: 'ann', sessionAt: 1 });
    sockets.track(fake('b'), { sessionId: 's2', personId: 'bo', sessionAt: 1 });
    expect(sockets.size).toBe(2);
    sockets.end({ kind: 'session', sessionId: 's1' });
    expect(sockets.size).toBe(1);
    sockets.forget('b');
    expect(sockets.size).toBe(0);
  });
});
