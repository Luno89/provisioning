const ancestorsOf = (path: string): string[] => path.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'));

export function dropPathQueries(commit: string, paths: readonly string[]): string {
  return paths.flatMap((path) => [...ancestorsOf(path), path]).map((path) => `${commit}:${path}\n`).join('');
}

export function blockedDropPath(paths: readonly string[], answers: string): { path: string; is: 'folder' | 'file'; dropped: string } | undefined {
  const types = answers.split('\n').filter(Boolean).map((line) => (line.endsWith(' missing') ? 'missing' : line.split(' ')[1]));
  let at = 0;
  for (const path of paths) {
    for (const ancestor of ancestorsOf(path)) {
      if (types[at++] === 'blob') return { path: ancestor, is: 'file', dropped: path };
    }
    if (types[at++] === 'tree') return { path, is: 'folder', dropped: path };
  }
  return undefined;
}
