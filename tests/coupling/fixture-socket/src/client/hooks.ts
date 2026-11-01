import { io, type Socket } from 'socket.io-client';

const socket: Socket = io('http://localhost');

export function useEvent(event: string, handler: (payload: unknown) => void): void {
  socket.on(event, handler);
}

export const sayHello = (): void => {
  socket.emit('hello', 'me');
};

export const listen = (): void => {
  useEvent('greeted', (payload) => { console.log(payload); });
  socket.on('connect', () => { console.log('connected'); });
};
