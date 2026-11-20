export type Kind = 'source' | 'test' | 'other';

export interface GateState { head: string; red?: { tests: string[]; at: string }; refactor?: { files: string[]; at: string } }
export interface TestRun { passed: boolean; output: string }
export type Verdict = { allow: true; red?: { tests: string[] } } | { allow: false; why: string };

const CODE = /\.(ts|tsx|js|mjs|cjs|sh)$/;
const TEST_FILE = /\.(test|integration\.test|real-[a-z-]+\.test)\.(ts|tsx)$|^tests\/[^/]+-live\.ts$/;
const TEST_HELPER = /(^|\/)(testing|test|fixture[^/]*)\//;
const SOURCE_ROOTS = /^(apps\/[^/]+\/src|packages\/[^/]+|scripts|tests)\//;
const NOT_HELD = new Set(['tests/alignment/decisions.ts', 'tests/alignment/answers.ts', 'tests/alignment/v1-flows.ts']);

export function kindOf(path: string): Kind {
  if (TEST_FILE.test(path) || (CODE.test(path) && TEST_HELPER.test(path))) return 'test';
  if (NOT_HELD.has(path)) return 'other';
  if (/^charts\/.*\.(ya?ml|tpl)$/.test(path)) return 'source';
  if (CODE.test(path) && SOURCE_ROOTS.test(path)) return 'source';
  return 'other';
}

export function vitestOf(checkout: string, gate: string, exists: (path: string) => boolean): string {
  const own = `${checkout}/node_modules/.bin/vitest`;
  return exists(own) ? own : `${gate}/node_modules/.bin/vitest`;
}

export function siblingTests(path: string, exists: (path: string) => boolean): string[] {
  const match = /^(.*)\.(ts|tsx)$/.exec(path);
  if (!match) return [];
  const stem = match[1]!;
  return [`${stem}.test.ts`, `${stem}.test.tsx`, `${stem}.integration.test.ts`, `${stem}.integration.test.tsx`].filter(exists);
}

const WRITE_FIRST = 'write the failing test first: this change has no new or changed test since the last commit, so there is nothing that shows the change is missing (red, then green, then refactor)';
const FAIL_FIRST = (tests: string[]) => `make it fail first: the new or changed tests (${tests.join(', ')}) already pass, so they cannot show the change is missing`;

export function editVerdict(state: GateState | undefined, head: string, changedTests: string[], run: TestRun | undefined): Verdict {
  if (state?.head === head && state.red) return { allow: true };
  if (changedTests.length === 0) return { allow: false, why: WRITE_FIRST };
  if (!run) return { allow: false, why: 'the new or changed tests could not be run, so red is not shown' };
  if (run.passed) return { allow: false, why: FAIL_FIRST(changedTests) };
  return { allow: true, red: { tests: changedTests } };
}

export interface CommitFacts {
  state: GateState | undefined;
  head: string;
  source: string[];
  removalsOnly: boolean;
  shrinks?: boolean;
  newTests?: string[];
  changedTests: string[];
  siblings: string[];
  run: TestRun | undefined;
}

const FAILED = /(^|\s)(FAIL|×|AssertionError|Error:)\s/;

const tail = (output: string) => {
  const kept = output.split('\n').filter((line) => line.trim());
  const failed = kept.filter((line) => FAILED.test(line)).slice(0, 40);
  return [...failed, ...(failed.length > 0 ? ['…'] : []), ...kept.slice(-25)].join('\n');
};

export function commitVerdict(facts: CommitFacts): Verdict {
  if (facts.source.length === 0 || facts.removalsOnly) return { allow: true };
  const red = facts.state?.head === facts.head && facts.state.red;
  if (facts.shrinks && (facts.newTests ?? []).length === 0 && facts.changedTests.length > 0) {
    if (!facts.run?.passed) return { allow: false, why: `a removal keeps what is left of its tests green, and these do not pass:\n${tail(facts.run?.output ?? '')}` };
    return { allow: true };
  }
  if (facts.changedTests.length > 0) {
    if (!red) return { allow: false, why: `the new or changed tests (${facts.changedTests.join(', ')}) were never seen failing before the source changed: show red first, then make it pass` };
    if (!facts.run?.passed) return { allow: false, why: `the change's tests do not pass yet:\n${tail(facts.run?.output ?? '')}` };
    return { allow: true };
  }
  if (facts.siblings.length === 0) return { allow: false, why: `this changes ${facts.source.join(', ')} with no test written for it and no test next to it: write the failing test first` };
  if (!facts.run?.passed) return { allow: false, why: `a refactor keeps its tests green, and these do not pass:\n${tail(facts.run?.output ?? '')}` };
  return { allow: true };
}
