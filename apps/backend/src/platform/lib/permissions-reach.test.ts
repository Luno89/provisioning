import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../..', import.meta.url));
const DECIDES = new Set(['platform/lib/permissions.ts']);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('who may do what is decided in one place', () => {
  const files = sources(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, 'utf8') }));

  it('reads isAdmin nowhere but the claims it gives, and the stores that keep it', () => {
    const readers = files.filter(({ path, text }) => !DECIDES.has(path) && !path.endsWith('/store.ts') && /\?*\.isAdmin\b/.test(text)).map(({ path }) => path);
    expect(readers).toEqual([]);
  });

  it('leaves no route deciding on its own', () => {
    const routes = files.filter(({ path }) => /\/routes\//.test(path));
    expect(routes.length).toBeGreaterThan(40);
    expect(routes.filter(({ text }) => /\.isAdmin\b|\bcan\(/.test(text)).map(({ path }) => path)).toEqual([]);
  });
});
