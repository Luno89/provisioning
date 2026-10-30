export interface SocketSession {
  sessionId: string;
  personId: string;
  sessionAt: number;
}

export type SessionEnding = { kind: 'session'; sessionId: string } | { kind: 'person'; personId: string; before: number };

export const endsSocket = (session: SocketSession, ending: SessionEnding): boolean =>
  ending.kind === 'session'
    ? session.sessionId === ending.sessionId
    : session.personId === ending.personId && session.sessionAt < ending.before;
