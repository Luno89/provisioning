
export interface Route {
  view: string;
  path: string[];
}

export function parseHash(hash: string): Route | undefined {
  const trimmed = hash.replace(/^#\/?/, '').trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split('/').map(decodeURIComponent).filter(Boolean);
  const view = parts[0];
  if (!view) return undefined;
  return { view, path: parts.slice(1) };
}

export function formatHash(view: string, path: string[] = []): string {
  const segments = [view, ...path.filter(Boolean)].map(encodeURIComponent);
  return `#/${segments.join('/')}`;
}

export function shouldReplace(from: Route | undefined, to: Route): boolean {
  if (!from) return true;
  if (from.view !== to.view) return false;
  return (from.path[0] ?? '') === (to.path[0] ?? '');
}

export const RETIRED_VIEWS: Record<string, string> = {
  chat: 'grove',
  board: 'grove',
  trees: 'grove',
};

export function resolveView(view: string | undefined, known: readonly string[], fallback: string): string {
  if (!view) return fallback;
  if (known.includes(view)) return view;
  return RETIRED_VIEWS[view] ?? fallback;
}
