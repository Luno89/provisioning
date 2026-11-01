export interface SocketLike {
  to(room: string): { emit(event: string, payload: unknown): unknown };
}

export const GREETED = 'greeted';

export const notifyGreeted = (io: SocketLike) => (who: string): void => {
  io.to(who).emit(GREETED, { who });
};
