export const LIVENESS_EVERY_MS = 10_000;

interface Beating {
  heartbeat(details?: unknown): void;
}

interface Execute {
  execute<I>(input: I, next: (input: I) => Promise<unknown>): Promise<unknown>;
}

export function heartbeatWhileRunning(every: number = LIVENESS_EVERY_MS) {
  return (ctx: Beating): { inbound: Execute } => ({
    inbound: {
      async execute(input, next) {
        const beat = () => { try { ctx.heartbeat(); } catch { return; } };
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
