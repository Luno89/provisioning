
const firstRead = new Map<string, string | undefined>();

export interface SeenOptions {
  dwellMs?: number;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  now?: () => string;
}

export function lastSeen(key: string, options: SeenOptions = {}): string | undefined {
  const storage = options.storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
  if (!firstRead.has(key)) {
    firstRead.set(key, storage?.getItem(key) ?? undefined);
  }
  return firstRead.get(key);
}

export function markSeenAfterDwell(key: string, options: SeenOptions = {}): () => void {
  const storage = options.storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
  const now = options.now ?? (() => new Date().toISOString());
  const dwell = options.dwellMs ?? 4000;

  const timer = setTimeout(() => storage?.setItem(key, now()), dwell);
  return () => clearTimeout(timer);
}

export function resetSeenCache(): void {
  firstRead.clear();
}
