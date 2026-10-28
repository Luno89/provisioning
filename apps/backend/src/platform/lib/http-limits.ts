export interface RateLimitRule {
  name: string;
  paths: readonly string[];
  prefixes: readonly string[];
  windowMs: number;
  max: number;
  said: string;
  countsOnlyFailures: boolean;
}

const MINUTES = 60_000;

export const JSON_LIMITS = { signedIn: '20mb', signedOut: '256kb' } as const;

const LARGE_WITHOUT_A_SESSION = ['/api/checks/scripted/', '/api/hub-instance/'];

export function jsonLimitFor(path: string, signedIn: boolean): keyof typeof JSON_LIMITS {
  return signedIn || LARGE_WITHOUT_A_SESSION.some((prefix) => path.startsWith(prefix)) ? 'signedIn' : 'signedOut';
}

export const RATE_LIMITS: readonly RateLimitRule[] = [
  {
    name: 'sign-in',
    paths: ['/auth/login', '/auth/register', '/auth/register/verify', '/auth/register/resend', '/auth/2fa/verify', '/auth/handoff', '/auth/sign-in'],
    prefixes: [],
    windowMs: 15 * MINUTES,
    max: 30,
    said: 'Too many sign-in attempts from this address; wait fifteen minutes and try again.',
    countsOnlyFailures: true,
  },
  {
    name: 'joining',
    paths: ['/hub-link/invite', '/hub-link/invitation', '/machines/join', '/instances/join', '/instances/hub-token'],
    prefixes: ['/hub/invitations/'],
    windowMs: 15 * MINUTES,
    max: 60,
    said: 'Too many requests from this address; wait a few minutes and try again.',
    countsOnlyFailures: true,
  },
  {
    name: 'share-links',
    paths: [],
    prefixes: ['/share/'],
    windowMs: 15 * MINUTES,
    max: 300,
    said: 'This link was opened too many times from this address; wait a few minutes and try again.',
    countsOnlyFailures: false,
  },
];

export const CSP_REPORT_LIMIT = { windowMs: 15 * MINUTES, max: 120 } as const;

const asRouted = (path: string): string => path.toLowerCase().replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1');

export const ruleFor = (path: string): RateLimitRule | undefined => {
  const routed = asRouted(path);
  return RATE_LIMITS.find((rule) => rule.paths.includes(routed) || rule.prefixes.some((prefix) => routed.startsWith(prefix)));
};

export interface SignInAttempts {
  failures: number[];
}

export const LOCKOUT = { after: 10, windowMs: 15 * MINUTES, forMs: 15 * MINUTES };

export function lockedUntil(attempts: SignInAttempts | undefined, now: number, rule = LOCKOUT): number | undefined {
  if (!attempts) return undefined;
  const recent = attempts.failures.filter((at) => now - at < rule.windowMs);
  if (recent.length < rule.after) return undefined;
  const last = Math.max(...recent);
  return last + rule.forMs > now ? last + rule.forMs : undefined;
}

export const afterFailure = (attempts: SignInAttempts | undefined, now: number, rule = LOCKOUT): SignInAttempts =>
  ({ failures: [...(attempts?.failures ?? []).filter((at) => now - at < rule.windowMs), now] });

export const lockedSaid = (until: number, now: number): string => {
  const minutes = Math.max(1, Math.ceil((until - now) / MINUTES));
  return `Too many failed sign-ins for this account; try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
};

export const attemptsKeyFor = (account: string, device: { account: string; id: string } | undefined): string =>
  device && device.account === account ? `device:${device.id}` : `account:${account}`;

export class SignInAttemptLog {
  private readonly held = new Map<string, SignInAttempts>();
  private prunedAt = 0;

  constructor(private readonly rule = LOCKOUT, private readonly pruneEveryMs = MINUTES) {}

  get size(): number {
    return this.held.size;
  }

  lockedUntil(key: string, now: number): number | undefined {
    return lockedUntil(this.held.get(key), now, this.rule);
  }

  failed(key: string, now: number): void {
    if (now - this.prunedAt >= this.pruneEveryMs) this.prune(now);
    this.held.set(key, afterFailure(this.held.get(key), now, this.rule));
  }

  succeeded(key: string): void {
    this.held.delete(key);
  }

  prune(now: number): void {
    this.prunedAt = now;
    const kept = Math.max(this.rule.windowMs, this.rule.forMs);
    for (const [key, attempts] of this.held) {
      if (attempts.failures.every((at) => now - at >= kept)) this.held.delete(key);
    }
  }
}
