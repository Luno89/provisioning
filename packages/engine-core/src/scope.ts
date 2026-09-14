import path from 'path';
import type { EnvironmentScope } from './environment.js';

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeError';
  }
}

export function scopeRoot(scope?: EnvironmentScope): string {
  if (!scope) return '';
  if (scope.worktree) return scope.worktree;
  return scope.path ?? '';
}

export function scopedPath(scope: EnvironmentScope | undefined, requested: string): string {
  const root = scopeRoot(scope);
  const cleaned = requested.replace(/^\/+/, '');

  if (!root) {
    const normalised = path.posix.normalize(cleaned);
    if (normalised.startsWith('..')) {
      throw new ScopeError(`"${requested}" points outside the working directory`);
    }
    return normalised;
  }

  const joined = path.posix.normalize(path.posix.join(root, cleaned));
  const base = path.posix.normalize(root);

  if (joined !== base && !joined.startsWith(`${base}/`)) {
    throw new ScopeError(`"${requested}" points outside ${base}`);
  }

  return joined;
}
