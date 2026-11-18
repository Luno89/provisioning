import type { TokenVia } from './device-tokens.js';

export interface TokenSocket {
  connected: boolean;
  emit(event: 'machine:token', payload: { token: string }, ack: (answer: unknown) => void): unknown;
}

export interface TokenRotation {
  rotationFor(deviceId: string, via: TokenVia): Promise<string | undefined>;
  tokenTaken(deviceId: string): Promise<void>;
}

export type Renewal = 'renewed' | 'refused' | 'not-due';

export async function rotateDeviceToken(socket: TokenSocket, deviceId: string, via: TokenVia, machines: TokenRotation): Promise<Renewal> {
  const token = await machines.rotationFor(deviceId, via);
  if (!token || !socket.connected) return 'not-due';
  const taken = await new Promise<boolean>((resolve) => {
    socket.emit('machine:token', { token }, (answer: unknown) => {
      resolve(Boolean(answer && typeof answer === 'object' && (answer as { taken?: unknown }).taken === true));
    });
  });
  if (!taken) return 'refused';
  await machines.tokenTaken(deviceId);
  return 'renewed';
}
