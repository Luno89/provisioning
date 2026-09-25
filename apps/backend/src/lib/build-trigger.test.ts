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

describe('an unbuildable Dockerfile does not reach the default branch', () => {
  const activity = read('../activities/ExecuteLeafActivity.ts');
  const settle = read('./leaf-run-settle.ts');
  const verdict = read('./leaf-run-verdict.ts');

  it('gates the merge on the Dockerfile check as well as verification', () => {
    expect(settle).toMatch(/if \(outputBranch && params\.combined === 'passed' && !params\.dockerProblems\)/);
  });

  it('still computes the problems before the merge decision', () => {
    const computed = activity.indexOf('const dockerProblems = producesCode ? await checkLeafDockerfile');
    const merge = activity.indexOf('return await settleSucceededLeaf(');
    expect(computed).toBeGreaterThan(-1);
    expect(computed).toBeLessThan(merge);
  });

  it('fails the leaf as well as blocking the merge', () => {
    expect(verdict).toMatch(/if \(params\.dockerProblems\) return \{ earned, combined, settled: 'failed' \}/);
  });
});
