export interface Tail {
  add(line: string): void;
  lines(): string[];
}

export function tail(limit: number): Tail {
  const kept: string[] = [];
  return {
    add(line) {
      kept.push(line);
      if (kept.length > limit) kept.shift();
    },
    lines: () => [...kept],
  };
}
