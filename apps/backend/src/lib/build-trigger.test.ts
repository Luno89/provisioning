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

  it('gates the merge on the Dockerfile check as well as verification', () => {
    expect(activity).toMatch(/if \(outputBranch && combined === 'passed' && !dockerProblems\)/);
  });

  it('still computes the problems before the merge decision', () => {
    const computed = activity.indexOf('dockerProblems = describeDockerfileProblems(');
    const gate = activity.indexOf("combined === 'passed' && !dockerProblems");
    expect(computed).toBeGreaterThan(-1);
    expect(computed).toBeLessThan(gate);
  });

  it('fails the leaf as well as blocking the merge', () => {
    expect(activity).toMatch(/dockerProblems \? 'failed' : decideStatus/);
  });
});

describe('a plan that mixes tool calls and prose', () => {
  const route = read('../routes/chat.ts');

  it('keeps prose proposals the tool calls did not cover', () => {
    expect(route).toMatch(/const fromProse = extracted\?\.length\s*\n?\s*\? extracted\s*\n?\s*: extractProposals\(reply, budget\.proposalsPerReply\)/);
    expect(route).toMatch(/newProposals\(fromProse/);
  });

  it('compares against this user\'s leaves on this branch, not every leaf on the instance', () => {
    const at = route.indexOf('const already = (await ownedLeaves(');
    expect(at).toBeGreaterThan(-1);
    expect(route.slice(at, at + 300)).toMatch(/l\.branchId === String\(branchId\)/);
  });

  it('reports look-alike leaves to the reviewer instead of dropping them', () => {
    expect(route).toMatch(/duplicateNotice\(suspectedDuplicates\(/);
  });

  it('assigns the pack the plan named, so a prose leaf can actually be started', () => {
    // myPacks, not myPersonas — Leaf.packId is a PersonaPack id. Resolving against the wrong
    // collection and writing its id under a field Leaf doesn't declare (personaId) is exactly the
    // bug that made every prose-extracted leaf come out unassigned regardless of what name matched.
    expect(route).toMatch(/resolvePersonaNamed\(proposal\.persona, myPacks\)/);
    expect(route).toMatch(/\.\.\.\(assigned \? \{ packId: assigned\.id \} : \{\}\)/);
  });
});
