import { koalaMetrics, type TelemetrySignal, type TelemetrySink } from '@koala/engine-core/telemetry';

export const MACHINE_TELEMETRY_MAX_BYTES = 4 * 1024 * 1024;
export const TELEMETRY_SIGNALS: readonly TelemetrySignal[] = ['traces', 'metrics'];

export type TelemetryAnswer = { ok: true } | { ok: false; error: string };

export interface TelemetryBatch {
  signal: TelemetrySignal;
  body: Buffer;
}

export function telemetryBatchFrom(raw: unknown): TelemetryBatch | { error: string } {
  const { signal, body } = (raw ?? {}) as { signal?: unknown; body?: unknown };
  if (typeof signal !== 'string' || !(TELEMETRY_SIGNALS as readonly string[]).includes(signal)) return { error: `the signal has to be one of ${TELEMETRY_SIGNALS.join(', ')}` };
  if (typeof body !== 'string' || !body) return { error: 'the batch has no body' };
  if (body.length > MACHINE_TELEMETRY_MAX_BYTES * 4 / 3 + 4) return { error: `a batch is at most ${MACHINE_TELEMETRY_MAX_BYTES} bytes` };
  const bytes = Buffer.from(body, 'base64');
  if (bytes.length === 0 || bytes.length > MACHINE_TELEMETRY_MAX_BYTES) return { error: `a batch is at most ${MACHINE_TELEMETRY_MAX_BYTES} bytes` };
  return { signal: signal as TelemetrySignal, body: bytes };
}

export interface MachineTelemetry {
  relay(raw: unknown): Promise<TelemetryAnswer>;
}

export function machineTelemetry(options: { sink: () => TelemetrySink | undefined }): MachineTelemetry {
  return {
    async relay(raw) {
      const batch = telemetryBatchFrom(raw);
      if ('error' in batch) return { ok: false, error: batch.error };
      const sink = options.sink();
      if (!sink) {
        koalaMetrics().telemetryRelayed.add(1, { signal: batch.signal, outcome: 'no-collector' });
        return { ok: false, error: 'this Koala has no collector to relay telemetry to' };
      }
      try {
        await sink.send(batch.signal, batch.body);
        koalaMetrics().telemetryRelayed.add(1, { signal: batch.signal, outcome: 'ok' });
        return { ok: true };
      } catch (err) {
        koalaMetrics().telemetryRelayed.add(1, { signal: batch.signal, outcome: 'failed' });
        return { ok: false, error: `the collector did not take it: ${(err as Error).message}` };
      }
    },
  };
}
