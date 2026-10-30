import { endsSocket, type SessionEnding, type SocketSession } from '../lib/session-sockets.js';

export interface ClosableSocket {
  id: string;
  disconnect(close?: boolean): unknown;
}

export class SessionSockets {
  private readonly open = new Map<string, { socket: ClosableSocket; session: SocketSession }>();

  get size(): number {
    return this.open.size;
  }

  track(socket: ClosableSocket, session: SocketSession): void {
    this.open.set(socket.id, { socket, session });
  }

  forget(socketId: string): void {
    this.open.delete(socketId);
  }

  end(ending: SessionEnding): number {
    let closed = 0;
    for (const [id, { socket, session }] of this.open) {
      if (!endsSocket(session, ending)) continue;
      this.open.delete(id);
      socket.disconnect(true);
      closed += 1;
    }
    return closed;
  }
}
