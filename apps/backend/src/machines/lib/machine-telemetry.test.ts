import { describe, expect, it } from 'vitest';
import type { TelemetrySink } from '@koala/engine-core/telemetry';
import { MACHINE_TELEMETRY_MAX_BYTES, machineTelemetry, telemetryBatchFrom } from './machine-telemetry.js';

const encoded = (text: string) => Buffer.from(text).toString('base64');

describe('telemetry a machine sends over its socket', () => {
  it('takes a traces or metrics batch as base64 and refuses anything else', () => {
    expect(telemetryBatchFrom({ signal: 'traces', body: encoded('{"resourceSpans":[]}') })).toEqual({ signal: 'traces', body: Buffer.from('{"resourceSpans":[]}') });
    expect(telemetryBatchFrom({ signal: 'logs', body: encoded('x') })).toEqual({ error: 'the signal has to be one of traces, metrics' });
    expect(telemetryBatchFrom({ signal: 'metrics' })).toEqual({ error: 'the batch has no body' });
    expect(telemetryBatchFrom(undefined)).toEqual({ error: 'the signal has to be one of traces, metrics' });
    expect(telemetryBatchFrom({ signal: 'metrics', body: encoded('x'.repeat(MACHINE_TELEMETRY_MAX_BYTES + 1)) })).toEqual({ error: `a batch is at most ${MACHINE_TELEMETRY_MAX_BYTES} bytes` });
  });

  it('relays a batch to the collector the backend itself reports to, and says when there is none or it refuses', async () => {
    const sent: { signal: string; body: string }[] = [];
    const sink: TelemetrySink = { async send(signal, body) { sent.push({ signal, body: Buffer.from(body).toString('utf8') }); } };
    expect(await machineTelemetry({ sink: () => sink }).relay({ signal: 'metrics', body: encoded('{"resourceMetrics":[]}') })).toEqual({ ok: true });
    expect(sent).toEqual([{ signal: 'metrics', body: '{"resourceMetrics":[]}' }]);
    expect(await machineTelemetry({ sink: () => undefined }).relay({ signal: 'metrics', body: encoded('{}') })).toEqual({ ok: false, error: 'this Koala has no collector to relay telemetry to' });
    const refusing: TelemetrySink = { async send() { throw new Error('the collector answered 503'); } };
    expect(await machineTelemetry({ sink: () => refusing }).relay({ signal: 'traces', body: encoded('{}') })).toEqual({ ok: false, error: 'the collector did not take it: the collector answered 503' });
    expect(await machineTelemetry({ sink: () => sink }).relay({ signal: 'nope' })).toEqual({ ok: false, error: 'the signal has to be one of traces, metrics' });
  });
});
