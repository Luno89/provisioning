import { koalaMetrics, telemetryStarted } from '@koala/engine-core/telemetry';

const MAX_CONCURRENT_PER_BUCKET = 1;
const DEFAULT_COOLDOWN_MS = 20_000;
const MIN_COOLDOWN_MS = 2_000;
const MAX_COOLDOWN_MS = 120_000;

interface BucketState {
  ownerId: string;
  label: string;
  inFlight: number;
  queue: (() => void)[];
  cooldownUntil?: number;
  totalRequests: number;
  total429: number;
  totalErrors: number;
  lastRequestAt?: number;
  lastStatus?: number;
}

export interface ModelRateLimitBucketSnapshot {
  key: string;
  label: string;
  inFlight: number;
  queued: number;
  cooldownUntil?: string;
  totalRequests: number;
  total429: number;
  totalErrors: number;
  lastRequestAt?: string;
  lastStatus?: number;
}

const buckets = new Map<string, BucketState>();

let queuesObserved = false;

function observeQueues(): void {
  if (queuesObserved || !telemetryStarted()) return;
  queuesObserved = true;
  koalaMetrics().modelQueued.addCallback((result) => {
    for (const b of buckets.values()) result.observe(b.queue.length, { provider: b.label });
  });
}

function bucketFor(key: string, ownerId: string, label: string): BucketState {
  observeQueues();
  let b = buckets.get(key);
  if (!b) {
    b = { ownerId, label, inFlight: 0, queue: [], totalRequests: 0, total429: 0, totalErrors: 0 };
    buckets.set(key, b);
  } else if (label) {
    b.label = label;
  }
  return b;
}

function stopped(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error(typeof signal?.reason === 'string' ? signal.reason : 'the call was stopped while it waited for the model');
}

export function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(stopped(signal));
    const onAbort = () => { clearTimeout(timer); reject(stopped(signal)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForCooldown(b: BucketState, signal: AbortSignal | undefined): Promise<void> {
  while (b.cooldownUntil && b.cooldownUntil > Date.now()) {
    await pause(b.cooldownUntil - Date.now(), signal);
  }
}

async function waitForSlot(b: BucketState, signal: AbortSignal | undefined): Promise<void> {
  for (;;) {
    await waitForCooldown(b, signal);
    if (b.inFlight < MAX_CONCURRENT_PER_BUCKET) {
      b.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(stopped(signal));
      const wake = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
      const onAbort = () => {
        const index = b.queue.indexOf(wake);
        if (index >= 0) b.queue.splice(index, 1);
        reject(stopped(signal));
      };
      b.queue.push(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export async function acquireModelSlot(key: string, ownerId: string, label: string, signal?: AbortSignal): Promise<() => void> {
  const b = bucketFor(key, ownerId, label);
  const queuedAt = Date.now();
  await waitForSlot(b, signal);
  koalaMetrics().modelQueueWaitSeconds.record((Date.now() - queuedAt) / 1000, { provider: b.label });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    b.inFlight = Math.max(0, b.inFlight - 1);
    const next = b.queue.shift();
    if (next) next();
  };
}

function parseRetryAfterMs(headers: Headers | undefined): number | undefined {
  const raw = headers?.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) return dateMs - Date.now();
  return undefined;
}

export function recordModelResponse(key: string, status: number, headers?: Headers): void {
  const b = buckets.get(key);
  if (!b) return;
  b.totalRequests += 1;
  b.lastRequestAt = Date.now();
  b.lastStatus = status;
  if (status === 429) {
    b.total429 += 1;
    koalaMetrics().modelRateLimitPauses.add(1, { provider: b.label });
    const requested = parseRetryAfterMs(headers) ?? DEFAULT_COOLDOWN_MS;
    const clamped = Math.min(Math.max(requested, MIN_COOLDOWN_MS), MAX_COOLDOWN_MS);
    b.cooldownUntil = Date.now() + clamped;
  }
}

export function recordModelFailure(key: string): void {
  const b = buckets.get(key);
  if (!b) return;
  b.totalErrors += 1;
  b.lastRequestAt = Date.now();
}

export function rateLimitedFetch(
  key: string | undefined,
  ownerId: string,
  label: string,
  impl: typeof fetch,
): typeof fetch {
  if (!key) return impl;
  const wrapped = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const release = await acquireModelSlot(key, ownerId, label, init?.signal ?? undefined);
    try {
      const res = await impl(input, init);
      recordModelResponse(key, res.status, res.headers);
      return res;
    } catch (err) {
      recordModelFailure(key);
      throw err;
    } finally {
      release();
    }
  }) as typeof fetch;
  return wrapped;
}

export function getModelRateLimiterSnapshot(ownerId: string): ModelRateLimitBucketSnapshot[] {
  const now = Date.now();
  return [...buckets.entries()]
    .filter(([, b]) => b.ownerId === ownerId)
    .map(([key, b]) => ({
      key,
      label: b.label,
      inFlight: b.inFlight,
      queued: b.queue.length,
      ...(b.cooldownUntil && b.cooldownUntil > now ? { cooldownUntil: new Date(b.cooldownUntil).toISOString() } : {}),
      totalRequests: b.totalRequests,
      total429: b.total429,
      totalErrors: b.totalErrors,
      ...(b.lastRequestAt ? { lastRequestAt: new Date(b.lastRequestAt).toISOString() } : {}),
      ...(b.lastStatus !== undefined ? { lastStatus: b.lastStatus } : {}),
    }))
    .sort((a, b) => (b.lastRequestAt ?? '').localeCompare(a.lastRequestAt ?? ''));
}
