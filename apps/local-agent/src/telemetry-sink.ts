import type { TelemetrySink } from '@koala/engine-core/telemetry';
import { askOver, type AskingSocket } from './remote-blobs.js';

export const TELEMETRY_EXPORT = 'telemetry:export';

export type TelemetryAnswer = { ok: true } | { ok: false; error: string };

export function socketSink(socket: AskingSocket): TelemetrySink {
  return {
    async send(signal, body) {
      const answer = await askOver<TelemetryAnswer | undefined>(socket, TELEMETRY_EXPORT, { signal, body: Buffer.from(body).toString('base64') });
      if (!answer?.ok) throw new Error(answer && 'error' in answer ? answer.error : 'Koala did not take the telemetry');
    },
  };
}
