export function globPattern(glob: string): RegExp {
  let pattern = '';
  for (let at = 0; at < glob.length; at += 1) {
    const char = glob[at]!;
    if (char === '*' && glob[at + 1] === '*') {
      const slash = glob[at + 2] === '/';
      pattern += slash ? '(?:.*/)?' : '.*';
      at += slash ? 2 : 1;
    } else if (char === '*') pattern += '[^/]*';
    else if (char === '?') pattern += '[^/]';
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

export function changedPaths(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const changed = new Set<string>();
  for (const [path, sha] of after) if (before.get(path) !== sha) changed.add(path);
  for (const path of before.keys()) if (!after.has(path)) changed.add(path);
  return [...changed].sort();
}

export type ReleaseDecision = { release: true } | { release: false; reason: string };

export function releaseDecision(changed: readonly string[], releaseWhen: readonly string[] | undefined, since: string): ReleaseDecision {
  if (!releaseWhen?.length) return { release: true };
  const patterns = releaseWhen.map(globPattern);
  if (changed.some((path) => patterns.some((pattern) => pattern.test(path)))) return { release: true };
  const named = changed.slice(0, 5).join(', ');
  return {
    release: false,
    reason: changed.length === 0
      ? `nothing changed since ${since.slice(0, 8)}`
      : `only ${named}${changed.length > 5 ? ` and ${changed.length - 5} more` : ''} changed since ${since.slice(0, 8)}, none of which the app is built from`,
  };
}

export function releasePathsProblem(paths: unknown): string | null {
  if (paths === undefined) return null;
  if (!Array.isArray(paths)) return 'releaseWhen must be a list of paths, like "src/**".';
  for (const path of paths) {
    if (typeof path !== 'string' || !path.trim()) return 'Each releaseWhen entry has to be a path, like "src/**".';
    if (path.startsWith('/') || path.split('/').includes('..')) return `releaseWhen path ${JSON.stringify(path)} must be relative and stay inside the repository.`;
  }
  return null;
}
