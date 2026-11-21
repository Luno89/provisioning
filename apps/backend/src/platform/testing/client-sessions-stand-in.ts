import { randomUUID } from 'node:crypto';
import type { Claim } from '../lib/permissions.js';
import type { ClientSession, ClientSessions } from '../middleware/auth.js';

const SESSION_SECONDS = 3600;

export interface StandInSessions {
  sessions: ClientSessions;
  signIn(person: { userId: string; email: string; claims: Claim[] }): string;
}

export function standInClientSessions(): StandInSessions {
  const made = new Map<string, ClientSession & { until: number }>();
  const ended = new Set<string>();
  return {
    sessions: {
      verified: (token) => (token ? made.get(token) : undefined),
      renew: async (session) => (ended.has(session.sid) ? 'ended' : 'kept'),
      end: async (session) => { ended.add(session.sid); },
      sessionSeconds: SESSION_SECONDS,
    },
    signIn: ({ userId, email, claims }) => {
      const token = randomUUID();
      const now = Date.now();
      made.set(token, { userId, email, sid: randomUUID(), sessionAt: now, freshUntil: now + SESSION_SECONDS * 1000, claims, until: now + SESSION_SECONDS * 1000 });
      return token;
    },
  };
}
