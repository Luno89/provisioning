import { describe, expect, it, vi } from 'vitest';
import { rotateDeviceToken } from './device-rotation.js';

const socketTaking = (answer: unknown) => {
  const emitted: { event: string; payload: { token: string } }[] = [];
  return {
    emitted,
    socket: {
      connected: true,
      emit: (event: 'machine:token', payload: { token: string }, ack: (answer: unknown) => void) => { emitted.push({ event, payload }); ack(answer); },
    },
  };
};

describe('rotateDeviceToken', () => {
  it('hands the agent its next token over the socket and promotes it once the agent says it kept it', async () => {
    const machines = { rotationFor: vi.fn(async () => 'next-token'), tokenTaken: vi.fn(async () => undefined) };
    const { socket, emitted } = socketTaking({ taken: true });
    expect(await rotateDeviceToken(socket, 'd1', 'current', machines)).toBe(true);
    expect(emitted).toEqual([{ event: 'machine:token', payload: { token: 'next-token' } }]);
    expect(machines.tokenTaken).toHaveBeenCalledWith('d1');
  });

  it('leaves both tokens standing when the agent could not keep the new one', async () => {
    const machines = { rotationFor: vi.fn(async () => 'next-token'), tokenTaken: vi.fn(async () => undefined) };
    const { socket } = socketTaking({ taken: false });
    expect(await rotateDeviceToken(socket, 'd1', 'current', machines)).toBe(false);
    expect(machines.tokenTaken).not.toHaveBeenCalled();
  });

  it('sends nothing when no rotation is due', async () => {
    const machines = { rotationFor: vi.fn(async () => undefined), tokenTaken: vi.fn(async () => undefined) };
    const { socket, emitted } = socketTaking({ taken: true });
    expect(await rotateDeviceToken(socket, 'd1', 'current', machines)).toBe(false);
    expect(emitted).toEqual([]);
  });
});
