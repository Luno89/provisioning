import { describe, expect, it } from 'vitest';
import { socketSink, TELEMETRY_EXPORT } from './telemetry-sink.js';
import type { AskingSocket } from './remote-blobs.js';

const fakeSocket = (answer: unknown, connected = true): AskingSocket & { sent: { event: string; payload: unknown }[] } => {
  const sent: { event: string; payload: unknown }[] = [];
  return {
    sent,
    connected,
    emit(event, payload, ack) { sent.push({ event, payload }); ack(answer as never); return undefined; },
    once() { return undefined; },
    off() { return undefined; },
  };
};

describe('a machine sends its telemetry over its socket', () => {
  it('asks Koala to relay each batch as base64, by signal, and is done when Koala says ok', async () => {
    const socket = fakeSocket({ ok: true });
    await socketSink(socket).send('traces', new TextEncoder().encode('{"resourceSpans":[]}'));
    expect(socket.sent).toEqual([{ event: TELEMETRY_EXPORT, payload: { signal: 'traces', body: Buffer.from('{"resourceSpans":[]}').toString('base64') } }]);
  });

  it('fails the batch with Koala\'s reason when it is refused, or when the machine is not connected', async () => {
    await expect(socketSink(fakeSocket({ ok: false, error: 'this Koala has no collector to relay telemetry to' })).send('metrics', new Uint8Array([1]))).rejects.toThrow('this Koala has no collector to relay telemetry to');
    await expect(socketSink(fakeSocket(undefined)).send('metrics', new Uint8Array([1]))).rejects.toThrow('Koala did not take the telemetry');
    await expect(socketSink(fakeSocket({ ok: true }, false)).send('metrics', new Uint8Array([1]))).rejects.toThrow('not connected');
  });
});
