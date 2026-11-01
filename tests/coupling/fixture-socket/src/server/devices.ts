import type { Socket } from 'socket.io';

const sockets = new Map<string, Socket>();

export function tellDevice(id: string, event: string): boolean {
  const socket = sockets.get(id);
  if (!socket) return false;
  socket.emit(event, {});
  return true;
}

export interface Devices {
  tell(id: string, event: string): boolean;
}

export class Machines {
  constructor(private readonly devices: Devices) {}

  wake(id: string): boolean {
    return this.devices.tell(id, 'device:wake');
  }
}

export const machines = new Machines({ tell: tellDevice });
