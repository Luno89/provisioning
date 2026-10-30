import { fullUntil, justLocked, lockedUntil, type LockoutRule } from '../lib/http-limits.js';
import type { PlatformStore } from '../store.js';

export class SignInAttemptLog {
  constructor(private readonly store: Pick<PlatformStore, 'attemptsOf' | 'countFailure' | 'clearAttempts'>, private readonly now: () => number = () => Date.now()) {}

  async lockedUntil(key: string, rule: LockoutRule): Promise<number | undefined> {
    return lockedUntil(await this.store.attemptsOf(key), this.now(), rule);
  }

  async failed(key: string, rule: LockoutRule): Promise<{ locked: boolean }> {
    const now = this.now();
    const { before, after } = await this.store.countFailure(key, now, rule);
    return { locked: justLocked(before, after, now, rule) };
  }

  async fullUntil(key: string, rule: LockoutRule): Promise<number | undefined> {
    return fullUntil(await this.store.attemptsOf(key), this.now(), rule);
  }

  async succeeded(key: string): Promise<void> {
    await this.store.clearAttempts(key);
  }
}
