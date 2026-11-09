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

export interface Silent {
  speak?: (() => string) | undefined;
}

export function talk(silent: Silent): string {
  return silent.speak?.() ?? '';
}
