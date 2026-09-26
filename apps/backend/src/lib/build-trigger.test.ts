import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), 'utf8');

describe('only the default branch builds', () => {
  const route = read('../index.ts');

  it('compares the pushed ref against the default branch', () => {
    expect(route).toMatch(/const defaultBranch = String\(payload\.repository\?\.default_branch/);
    expect(route).toMatch(/if \(ref !== defaultBranch\)/);
  });

  it('takes the branch name from the payload rather than assuming main', () => {
    const at = route.indexOf('const defaultBranch');
    const line = route.slice(at, route.indexOf('\n', at));
    expect(line).toContain('payload.repository');
  });

  it('refuses BEFORE starting the pipeline, not after', () => {
    const guard = route.indexOf('if (ref !== defaultBranch)');
    const start = route.indexOf('temporalBridge.runPipeline(project');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(start);
  });
});
