import type { TokenVia } from './device-tokens.js';

export interface TokenSocket {
  connected: boolean;
  emit(event: 'machine:token', payload: { token: string }, ack: (answer: unknown) => void): unknown;
}

export interface TokenRotation {
  rotationFor(deviceId: string, via: TokenVia): Promise<string | undefined>;
  tokenTaken(deviceId: string): Promise<void>;
}

export async function rotateDeviceToken(socket: TokenSocket, deviceId: string, via: TokenVia, machines: TokenRotation): Promise<boolean> {
  const token = await machines.rotationFor(deviceId, via);
  if (!token || !socket.connected) return false;
  return new Promise((resolve) => {
    socket.emit('machine:token', { token }, (answer: unknown) => {
      const taken = Boolean(answer && typeof answer === 'object' && (answer as { taken?: unknown }).taken === true);
      if (!taken) return resolve(false);
      machines.tokenTaken(deviceId).then(() => resolve(true), () => resolve(false));
    });
  });
}
