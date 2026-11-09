export interface Clock {
  now?: (() => string) | undefined;
  never?: (() => string) | undefined;
}

export function stampWith(clock: Clock): string {
  return clock.now?.() ?? 'now';
}

export function stampNever(clock: Clock): string {
  return clock.never?.() ?? 'never';
}
