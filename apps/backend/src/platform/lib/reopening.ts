export const REOPEN_FIRST_MS = 5_000;
export const REOPEN_MOST_MS = 60_000;

export interface Reopening {
  readonly seconds: number;
  later(run: () => void): ReturnType<typeof setTimeout>;
  after(): Promise<void>;
  reset(): void;
}

export function reopening(firstMs = REOPEN_FIRST_MS): Reopening {
  let wait = firstMs;
  const grow = () => { wait = Math.min(wait * 2, Math.max(firstMs, REOPEN_MOST_MS)); };
  return {
    get seconds() { return Math.round(wait / 1000); },
    later(run) {
      const timer = setTimeout(run, wait);
      grow();
      return timer;
    },
    after() {
      return new Promise<void>((resume) => { this.later(resume); });
    },
    reset() { wait = firstMs; },
  };
}
