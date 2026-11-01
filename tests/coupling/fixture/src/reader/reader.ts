export interface Reads {
  read(id: string): string;
}

export interface Runner {
  (command: string): string;
}

export interface Deps {
  store: Reads;
  run: Runner;
}

export function readOne(deps: Deps, id: string): string {
  return deps.run(deps.store.read(id));
}

export interface Formatter {
  (text: string): string;
}

export function formatAll(format: Formatter, items: readonly string[]): string[] {
  return items.map((item) => format(item));
}
