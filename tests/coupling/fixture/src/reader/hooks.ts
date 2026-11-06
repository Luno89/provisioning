export interface Hooks {
  onDone?: (id: string) => string;
  onLoud: (id: string) => string;
}

function local(id: string): string {
  return id;
}

export function finish(hooks: Hooks, id: string): string {
  return `${hooks.onDone?.(id) ?? ''}${hooks.onLoud(id)}${local(id)}`;
}
