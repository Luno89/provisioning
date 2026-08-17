import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * What is allowed to trigger a build, and what is allowed to reach the default branch.
 *
 * ── TWO GATES THAT WERE NOT THERE ──
 * 1. The push webhook did not filter by branch. Every leaf pushes `koala/<leafId>` BEFORE its
 *    verification runs, so each one triggered a full image build from unverified work, and
 *    `autoDeployOnBuild` promoted whatever came out. On the last run that was most of the traffic.
 *
 * 2. The Dockerfile check set the leaf's STATUS but not the MERGE gate, which reads `combined`. A
 *    leaf with passing tests and an unbuildable Dockerfile was marked failed and merged anyway —
 *    the broken file landed on main and the pipeline built it. Catching a fault and letting it
 *    through is worse than not catching it, because it reads as covered.
 *
 * ── WHY THIS READS THE SOURCE ──
 * Both are single conditions in long activity and route functions that need a database, a cluster
 * and a live Gitea to execute. The failure mode for both is a condition being DROPPED, and reading
 * for it catches that in a way no reachable unit test here would.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), 'utf8');

describe('only the default branch builds', () => {
  const route = read('../index.ts');

  it('compares the pushed ref against the default branch', () => {
    expect(route).toMatch(/const defaultBranch = String\(payload\.repository\?\.default_branch/);
    expect(route).toMatch(/if \(ref !== defaultBranch\)/);
  });

  it('takes the branch name from the payload rather than assuming main', () => {
    /**
     * A repository on `master` or `trunk` would otherwise build nothing at all, silently — the
     * worst kind of filter, because it looks like the pipeline is simply never triggered.
     */
    const at = route.indexOf('const defaultBranch');
    const line = route.slice(at, route.indexOf('\n', at));
    expect(line).toContain('payload.repository');
  });

  it('refuses BEFORE starting the pipeline, not after', () => {
    // Starting the run and then discarding it would still create a record and a workflow.
    const guard = route.indexOf('if (ref !== defaultBranch)');
    const start = route.indexOf('temporalBridge.runPipeline(project');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(start);
  });
});

describe('an unbuildable Dockerfile does not reach the default branch', () => {
  const activity = read('../activities/ExecuteLeafActivity.ts');

  it('gates the merge on the Dockerfile check as well as verification', () => {
    expect(activity).toMatch(/if \(outputBranch && combined === 'passed' && !dockerProblems\)/);
  });

  it('still computes the problems before the merge decision', () => {
    // Ordering matters: the check reads the workspace, and reading it after the merge would gate
    // on a variable that is always empty.
    const computed = activity.indexOf('dockerProblems = describeDockerfileProblems(');
    const gate = activity.indexOf("combined === 'passed' && !dockerProblems");
    expect(computed).toBeGreaterThan(-1);
    expect(computed).toBeLessThan(gate);
  });

  it('fails the leaf as well as blocking the merge', () => {
    // Blocking the merge without failing the leaf would leave a green leaf whose work never landed.
    expect(activity).toMatch(/dockerProblems \? 'failed' : decideStatus/);
  });
});
