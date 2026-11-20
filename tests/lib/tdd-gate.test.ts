import { describe, expect, it } from 'vitest';
import { commitVerdict, editVerdict, kindOf, siblingTests, vitestOf, type GateState } from './tdd-gate.js';

const HEAD = 'abc123';

describe('what counts as source, a test, or neither', () => {
  it('holds code under the workspaces, scripts and the chart to red-green', () => {
    for (const path of ['apps/backend/src/machines/services/KoalaInstalls.ts', 'packages/provision/src/chart.ts', 'apps/frontend/src/features/machines/components/MyMachines.tsx', 'scripts/ci-tools.sh', 'charts/instance/templates/app.yaml', 'tests/lib/gates.ts', 'packages/cdktf-infra/constructs/vllm.ts']) {
      expect(kindOf(path), path).toBe('source');
    }
  });

  it('knows a test file and the helpers tests are built from', () => {
    for (const path of ['apps/backend/src/machines/services/KoalaInstalls.test.ts', 'apps/backend/src/machines/wiring/sides.integration.test.ts', 'apps/backend/src/workflows/StoredFilesWorkflow.real-temporal.test.ts', 'apps/frontend/src/features/machines/components/MyMachines.test.tsx', 'apps/backend/src/machines/testing/wiring-world.ts', 'apps/frontend/src/test/backend/machines.ts', 'tests/coupling/fixture-temporal/workflows.ts', 'tests/restore-live.ts']) {
      expect(kindOf(path), path).toBe('test');
    }
  });

  it('leaves plans, docs, settings, data and the decisions register, its answers and its v1 steps alone', () => {
    for (const path of ['CLAUDE.md', 'docs/runbook.md', 'tests/alignment/decisions.ts', 'tests/alignment/answers.ts', 'tests/alignment/v1-flows.ts', 'tests/coupling/baseline.json', 'dependencies.pins.json', '.claude/settings.json', 'package-lock.json']) {
      expect(kindOf(path), path).toBe('other');
    }
  });
});

describe('editing source before a test has been seen failing', () => {
  const none: GateState | undefined = undefined;

  it('lets the edit through once this change has been red', () => {
    expect(editVerdict({ head: HEAD, red: { tests: ['a.test.ts'], at: 't' } }, HEAD, [], undefined)).toEqual({ allow: true });
  });

  it('refuses when no test was written or changed for this change', () => {
    const verdict = editVerdict(none, HEAD, [], undefined);
    expect(verdict.allow).toBe(false);
    expect(verdict.allow === false && verdict.why).toMatch(/write the failing test first/);
  });

  it('refuses when the new tests already pass, since they cannot show the change is missing', () => {
    const verdict = editVerdict(none, HEAD, ['x.test.ts'], { passed: true, output: 'Tests  3 passed' });
    expect(verdict.allow).toBe(false);
    expect(verdict.allow === false && verdict.why).toMatch(/make it fail first/);
  });

  it('records red and lets the edit through when the new tests fail', () => {
    expect(editVerdict(none, HEAD, ['x.test.ts'], { passed: false, output: 'FAIL x.test.ts' })).toEqual({ allow: true, red: { tests: ['x.test.ts'] } });
  });

  it('does not count red seen before the last commit', () => {
    const verdict = editVerdict({ head: 'older', red: { tests: ['a.test.ts'], at: 't' } }, HEAD, [], undefined);
    expect(verdict.allow).toBe(false);
  });
});

describe('committing source', () => {
  const red: GateState = { head: HEAD, red: { tests: ['x.test.ts'], at: 't' } };

  it('lets a commit with no source through untouched', () => {
    expect(commitVerdict({ state: undefined, head: HEAD, source: [], removalsOnly: false, changedTests: [], siblings: [], run: undefined })).toEqual({ allow: true });
  });

  it('lets a commit that only removes code through', () => {
    expect(commitVerdict({ state: undefined, head: HEAD, source: ['a.ts'], removalsOnly: true, changedTests: [], siblings: [], run: undefined })).toEqual({ allow: true });
  });

  it('refuses a new test that was never seen failing', () => {
    const verdict = commitVerdict({ state: undefined, head: HEAD, source: ['a.ts'], removalsOnly: false, changedTests: ['x.test.ts'], siblings: [], run: { passed: true, output: '' } });
    expect(verdict.allow).toBe(false);
    expect(verdict.allow === false && verdict.why).toMatch(/never seen failing/);
  });

  it('refuses until the change\'s tests pass', () => {
    const verdict = commitVerdict({ state: red, head: HEAD, source: ['a.ts'], removalsOnly: false, changedTests: ['x.test.ts'], siblings: [], run: { passed: false, output: 'FAIL x.test.ts > it' } });
    expect(verdict.allow).toBe(false);
    expect(verdict.allow === false && verdict.why).toMatch(/FAIL x\.test\.ts/);
  });

  it('lets red then green through', () => {
    expect(commitVerdict({ state: red, head: HEAD, source: ['a.ts'], removalsOnly: false, changedTests: ['x.test.ts'], siblings: [], run: { passed: true, output: '' } })).toEqual({ allow: true });
  });

  it('lets a refactor through when the touched code\'s own tests pass', () => {
    expect(commitVerdict({ state: undefined, head: HEAD, source: ['a.ts'], removalsOnly: false, changedTests: [], siblings: ['a.test.ts'], run: { passed: true, output: '' } })).toEqual({ allow: true });
  });

  it('lets a removal through once the tests it trimmed pass, since a test that only lost cases has nothing to fail on first', () => {
    expect(commitVerdict({ state: undefined, head: HEAD, source: ['a.ts'], removalsOnly: false, shrinks: true, newTests: [], changedTests: ['x.test.ts'], siblings: [], run: { passed: true, output: '' } })).toEqual({ allow: true });
  });

  it('refuses a removal whose trimmed tests do not pass', () => {
    const verdict = commitVerdict({ state: undefined, head: HEAD, source: ['a.ts'], removalsOnly: false, shrinks: true, newTests: [], changedTests: ['x.test.ts'], siblings: [], run: { passed: false, output: 'FAIL x.test.ts > it' } });
    expect(verdict.allow).toBe(false);
    expect(verdict.allow === false && verdict.why).toMatch(/FAIL x\.test\.ts/);
  });

  it('runs a checkout\'s tests with that checkout\'s own vitest, so a worktree never loads a second copy of its libraries, and the gate\'s own only where the checkout has none', () => {
    const worktree = '/code/.claude/worktrees/w';
    expect(vitestOf(worktree, '/code', (path) => path === `${worktree}/node_modules/.bin/vitest`)).toBe(`${worktree}/node_modules/.bin/vitest`);
    expect(vitestOf('/tmp/a-repo', '/code', () => false)).toBe('/code/node_modules/.bin/vitest');
  });

  it('names the failing tests when other workspaces\' passing runs come after them', () => {
    const output = ['FAIL |integration| src/a.integration.test.ts > keeps it', '× keeps it 12ms', ...Array.from({ length: 40 }, (_, at) => `passing line ${at}`)].join('\n');
    const verdict = commitVerdict({ state: undefined, head: HEAD, source: ['a.ts'], removalsOnly: false, shrinks: true, newTests: [], changedTests: ['x.test.ts'], siblings: [], run: { passed: false, output } });
    expect(verdict.allow === false && verdict.why).toMatch(/FAIL \|integration\| src\/a\.integration\.test\.ts > keeps it/);
  });

  it('still holds a removal that brings a new test file to red first', () => {
    const verdict = commitVerdict({ state: undefined, head: HEAD, source: ['a.ts'], removalsOnly: false, shrinks: true, newTests: ['y.test.ts'], changedTests: ['x.test.ts', 'y.test.ts'], siblings: [], run: { passed: true, output: '' } });
    expect(verdict.allow).toBe(false);
    expect(verdict.allow === false && verdict.why).toMatch(/never seen failing/);
  });

  it('refuses a change to code that no test is next to and no test was written for', () => {
    const verdict = commitVerdict({ state: undefined, head: HEAD, source: ['a.ts'], removalsOnly: false, changedTests: [], siblings: [], run: undefined });
    expect(verdict.allow).toBe(false);
    expect(verdict.allow === false && verdict.why).toMatch(/no test/);
  });
});

describe('the tests that sit next to a file', () => {
  it('finds a file\'s own unit and integration tests among those that exist', () => {
    const exists = new Set(['apps/backend/src/a/b.test.ts', 'apps/backend/src/a/b.integration.test.ts', 'apps/backend/src/a/c.test.ts']);
    expect(siblingTests('apps/backend/src/a/b.ts', (path) => exists.has(path))).toEqual(['apps/backend/src/a/b.test.ts', 'apps/backend/src/a/b.integration.test.ts']);
    expect(siblingTests('apps/frontend/src/X.tsx', () => false)).toEqual([]);
  });
});
