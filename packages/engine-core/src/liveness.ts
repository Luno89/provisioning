import { koalaMetrics } from './telemetry.js';

export const LIVENESS_EVERY_MS = 10_000;
export const LATE_BEAT_SHARE = 0.5;

interface Beating {
  heartbeat(details?: unknown): void;
  info?: { activityType: string } | undefined;
}

interface Execute {
  execute<I>(input: I, next: (input: I) => Promise<unknown>): Promise<unknown>;
}

export const lateBy = (expectedMs: number, actualMs: number): number | undefined =>
  (actualMs - expectedMs > expectedMs * LATE_BEAT_SHARE ? (actualMs - expectedMs) / 1000 : undefined);

export function heartbeatWhileRunning(every: number = LIVENESS_EVERY_MS) {
  return (ctx: Beating): { inbound: Execute } => ({
    inbound: {
      async execute(input, next) {
        let last = Date.now();
        const beat = () => {
          const now = Date.now();
          const late = lateBy(every, now - last);
          if (late !== undefined) koalaMetrics().heartbeatGapSeconds.record(late, { 'activity.type': ctx.info?.activityType ?? 'unknown' });
          last = now;
          try { ctx.heartbeat(); } catch { return; }
        };
        beat();
        const beating = setInterval(beat, every);
        try {
          return await next(input);
        } finally {
          clearInterval(beating);
        }
      },
    },
  });
}
