import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { askOver, payloadRingOver, remoteBlobs, ringFingerprint, type AskingSocket } from './remote-blobs.js';

const socketAnswering = (answer: (event: string, payload: unknown) => unknown, connected = true) => {
  const sent: { event: string; payload: unknown }[] = [];
  const socket: AskingSocket = {
    connected,
    once: () => socket,
    off: () => socket,
    emit(event, payload, ack) {
      sent.push({ event, payload });
      (ack as (value: unknown) => void)(answer(event, payload));
      return true;
    },
  };
  return { socket, sent };
};

describe('payloads a machine keeps with its instance', () => {
  it('stores and fetches large payloads through Koala, by id', async () => {
    const id = randomUUID();
    const kept = new Map<string, string>();
    const { socket, sent } = socketAnswering((event, payload) => {
      if (event === 'payloads:put') {
        for (const blob of (payload as { blobs: { id: string; data: string }[] }).blobs) kept.set(blob.id, blob.data);
        return { ok: true };
      }
      const ids = (payload as { ids: string[] }).ids;
      return { found: Object.fromEntries(ids.filter((one) => kept.has(one)).map((one) => [one, kept.get(one)])) };
    });
    const blobs = remoteBlobs(socket);
    await blobs.put([{ id, data: Buffer.from('a large tool result'), workflowId: 'run-1', storedAt: new Date('2026-10-15T00:00:00Z') }]);
    expect(sent[0]).toEqual({ event: 'payloads:put', payload: { blobs: [{ id, data: Buffer.from('a large tool result').toString('base64'), workflowId: 'run-1', storedAt: '2026-10-15T00:00:00.000Z' }] } });
    const found = await blobs.get([id]);
    expect(Buffer.from(found.get(id)!).toString()).toBe('a large tool result');
  });

  it('fails a store Koala refused, saying why', async () => {
    const { socket } = socketAnswering(() => ({ ok: false, error: 'a payload was not in the shape Koala stores' }));
    await expect(remoteBlobs(socket).put([{ id: randomUUID(), data: Buffer.from('x'), storedAt: new Date() }])).rejects.toThrow('a payload was not in the shape Koala stores');
  });

  it('takes the payload keyring Koala hands it, and refuses to go on without one', async () => {
    const ring = { current: 'c'.repeat(64), previous: ['p'.repeat(64)] };
    expect(await payloadRingOver(socketAnswering(() => ({ ring })).socket)).toEqual(ring);
    await expect(payloadRingOver(socketAnswering(() => ({ error: 'this Koala runs no work on machines' })).socket)).rejects.toThrow('this Koala runs no work on machines');
    expect(ringFingerprint(ring)).not.toBe(ringFingerprint({ current: 'c'.repeat(64) }));
  });

  it('does not ask while the machine is not connected', async () => {
    await expect(askOver(socketAnswering(() => ({}), false).socket, 'payloads:get', { ids: [] })).rejects.toThrow('this machine is not connected to Koala right now');
  });
});
