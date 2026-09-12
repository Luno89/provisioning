export function isSafeRepoDir(p: string): boolean {
  return !p.startsWith('/') && !p.split('/').includes('..');
}

export function isSafeRepoFilePath(p: string): boolean {
  return p.trim().length > 0 && isSafeRepoDir(p);
}
