const MAX_CONCURRENT_PER_BUCKET = 1;
const DEFAULT_COOLDOWN_MS = 20_000;
const MIN_COOLDOWN_MS = 2_000;
const MAX_COOLDOWN_MS = 120_000;
const MAX_QUEUE_WAIT_MS = 8 * 60_000;

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

function bucketFor(key: string, ownerId: string, label: string): BucketState {
  let b = buckets.get(key);
  if (!b) {
    b = { ownerId, label, inFlight: 0, queue: [], totalRequests: 0, total429: 0, totalErrors: 0 };
    buckets.set(key, b);
  } else if (label) {
    b.label = label;
  }
  return b;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCooldown(b: BucketState, deadline: number): Promise<void> {
  while (b.cooldownUntil && b.cooldownUntil > Date.now()) {
    if (Date.now() >= deadline) throw new Error('Model endpoint rate-limit queue timed out waiting out a cooldown');
    await sleep(Math.min(b.cooldownUntil - Date.now(), deadline - Date.now()));
  }
}

async function waitForSlot(b: BucketState, deadline: number): Promise<void> {
  await waitForCooldown(b, deadline);
  if (b.inFlight < MAX_CONCURRENT_PER_BUCKET) {
    b.inFlight += 1;
    return;
  }
  if (Date.now() >= deadline) throw new Error('Model endpoint rate-limit queue timed out waiting for a free slot');
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = b.queue.indexOf(wake);
      if (idx >= 0) b.queue.splice(idx, 1);
      reject(new Error('Model endpoint rate-limit queue timed out waiting for a free slot'));
    }, Math.max(0, deadline - Date.now()));
    function wake() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    }
    b.queue.push(wake);
  });
  return waitForSlot(b, deadline);
}

export async function acquireModelSlot(key: string, ownerId: string, label: string): Promise<() => void> {
  const b = bucketFor(key, ownerId, label);
  const deadline = Date.now() + MAX_QUEUE_WAIT_MS;
  await waitForSlot(b, deadline);
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
    const release = await acquireModelSlot(key, ownerId, label);
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
