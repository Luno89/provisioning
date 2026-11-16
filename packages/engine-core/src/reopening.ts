import { failureOf, temporaryStatus } from './failures.js';
export const REOPEN_FIRST_MS = 5_000;
export const REOPEN_MOST_MS = 60_000;

export interface Reopening {
  readonly seconds: number;
  take(): number;
  later(run: () => void): ReturnType<typeof setTimeout>;
  after(): Promise<void>;
  reset(): void;
}

export function reopening(firstMs = REOPEN_FIRST_MS): Reopening {
  let wait = firstMs;
  const grow = () => { wait = Math.min(wait * 2, Math.max(firstMs, REOPEN_MOST_MS)); };
  return {
    get seconds() { return Math.round(wait / 1000); },
    take() {
      const now = wait;
      grow();
      return now;
    },
    later(run) {
      return setTimeout(run, this.take());
    },
    after() {
      return new Promise<void>((resume) => { this.later(resume); });
    },
    reset() { wait = firstMs; },
  };
}

export async function untilAnswered(ask: () => Promise<Response>, wait: Reopening, waiting: (why: string, seconds: number) => void): Promise<Response> {
  for (;;) {
    const answer = await ask().catch((err: unknown) => {
      const failure = failureOf(err);
      if (failure.kind === 'final') throw err;
      return failure.reason;
    });
    if (typeof answer !== 'string' && !temporaryStatus(answer.status)) {
      wait.reset();
      return answer;
    }
    waiting(typeof answer === 'string' ? answer : `it answered ${answer.status}`, wait.seconds);
    await wait.after();
  }
}
