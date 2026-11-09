import { describe, expect, it } from 'vitest';
import type { Flow, Step } from './flow-spec.js';
import { driftOf, type DriftInput } from './drift.js';
import type { StepTrace } from './trace.js';

const trace = (step: string, overrides: Partial<StepTrace> = {}): StepTrace =>
  ({ step, starts: [`ui/api.ts#${step}`], notFound: [], files: [], areas: [], crossings: [], concepts: {}, gaps: [], ...overrides });

const step = (id: string, overrides: Partial<Step> = {}): Step => ({ id, does: id, screen: { on: 'terminal' }, decisions: ['v1'], ...overrides });

const input = (steps: Step[], traces: StepTrace[], overrides: Partial<DriftInput> = {}): DriftInput => ({
  flows: [{ id: 'E', title: 'E', who: 'E', steps } satisfies Flow],
  decisions: [],
  traces: new Map(traces.map((entry) => [entry.step, entry])),
  sourceOf: () => undefined,
  plans: [],
  said: [],
  ...overrides,
});

const kinds = (found: ReturnType<typeof driftOf>): string[] => found.map((finding) => `${finding.kind} ${finding.steps.join(',')}`);

describe('drift between what was agreed and what the code does', () => {
  it('finds nothing when every step names code the map follows', () => {
    expect(driftOf(input([step('E1')], [trace('E1')]))).toEqual([]);
  });

  it('names a step with no code and one whose start the map does not hold', () => {
    const found = driftOf(input([step('E1'), step('E2')], [trace('E1', { starts: [] }), trace('E2', { notFound: ['scripts/dev.sh#(script)'] })]));
    expect(kinds(found)).toEqual(['missing E1', 'missing E2']);
    expect(found[1]!.where).toEqual(['scripts/dev.sh#(script)']);
  });

  it('names two steps of one job that start apart and never meet, and passes two that meet in a service', () => {
    const apart = driftOf(input([step('E1', { job: 'Add a machine' }), step('E2', { job: 'Add a machine' })], [
      trace('E1', { files: ['apps/backend/src/x/routes/a.ts', 'apps/backend/src/x/services/A.ts'] }),
      trace('E2', { files: ['apps/backend/src/x/routes/b.ts', 'apps/backend/src/x/services/B.ts'] }),
    ]));
    expect(kinds(apart)).toEqual(['two-paths E1,E2']);
    const meeting = driftOf(input([step('E1', { job: 'Add a machine' }), step('E2', { job: 'Add a machine' })], [
      trace('E1', { files: ['apps/backend/src/x/routes/a.ts', 'apps/backend/src/x/services/Accounts.ts'] }),
      trace('E2', { files: ['apps/backend/src/x/routes/b.ts', 'apps/backend/src/x/services/Accounts.ts'] }),
    ]));
    expect(meeting).toEqual([]);
  });

  it('calls a branch on something a decision removes known work, and a branch nothing settles a question', () => {
    const source = 'if (cluster.provider === \'k3d\') return\nconst ok = gpus > 0 ? gpus : 0\nconst k3dName = name\n// if (k3d) old';
    const found = driftOf(input([step('E1')], [trace('E1', { files: ['apps/backend/src/x/services/A.ts'] })], { sourceOf: () => source }));
    expect(kinds(found)).toEqual(['decided-not-done E1', 'decided-not-done E1', 'undecided-branch E1']);
    expect(found.find((finding) => finding.id === 'decided-not-done:k3d')?.where).toEqual(['apps/backend/src/x/services/A.ts:1  if (cluster.provider === \'k3d\') return']);
  });

  it('takes a branch settled when the step, or one of its branches, rests on a decision covering that word', () => {
    const source = 'if (gpus > 0) startGpus()';
    const files = ['apps/backend/src/x/services/A.ts'];
    const byBranch = step('E1', { branches: [{ when: 'a GPU', outcome: 'k3s', decision: 'gpu-unusable' }] });
    expect(driftOf(input([byBranch], [trace('E1', { files })], { sourceOf: () => source }))).toEqual([]);
    expect(driftOf(input([step('E1', { decisions: ['gpu-is-core'] })], [trace('E1', { files })], { sourceOf: () => source }))).toEqual([]);
  });

  it('always reports code branching on what a decision removes, whatever the step rests on', () => {
    const source = 'if (cluster.isSystem) return';
    const found = driftOf(input([step('E1', { decisions: ['one-cluster-per-machine'] })], [trace('E1', { files: ['apps/backend/src/x/services/A.ts'] })], { sourceOf: () => source }));
    expect(found.map((finding) => finding.id)).toEqual(['decided-not-done:the system cluster']);
  });

  it('takes a folder named after a tool, such as Kaniko\'s .docker, for no branch on that tool', () => {
    const source = 'const mounts = [...(login ? [{ name: \'registry\', mountPath: \'/kaniko/.docker\' }] : [])]\nif (docker.ok) say(\'Docker\')';
    const found = driftOf(input([step('E1')], [trace('E1', { files: ['apps/backend/src/x/services/A.ts'] })], { sourceOf: () => source }));
    expect(found.find((finding) => finding.id === 'decided-not-done:Docker')?.where).toEqual(['apps/backend/src/x/services/A.ts:2  if (docker.ok) say(\'Docker\')']);
  });

  it('reads no branch into words inside a message or a template', () => {
    const source = 'throw new Error(`Is the cluster running? Run sudo systemctl start k3s`)\nlog(\'restart it with sudo ? maybe\')';
    expect(driftOf(input([step('E1')], [trace('E1', { files: ['apps/backend/src/x/services/A.ts'] })], { sourceOf: () => source }))).toEqual([]);
  });

  it('names a plan quoting the owner with words they never said, and passes quotes they did, elided ones too', () => {
    const said = [{ at: '2026-10-26T23:10:00.000Z', session: 's', how: 'typed' as const, text: 'Members probably should have access, we can pair it down later, the mcp tools may need to be scope aware' }];
    const plans = [{ file: 'CLAUDE.md', text: 'members see it all (owner, 2026-10-26: "we can pare it down later").\nkept (owner: "we can pair it down later ... the mcp tools may need to be scope aware").\nmonitoringOwner\'s "renaming of the cluster" goes.' }];
    const found = driftOf(input([], [], { plans, said }));
    expect(found.map((finding) => finding.id)).toEqual(['misquote:CLAUDE.md:1']);
  });

  it('names each step resting on an assumption, with the assumption', () => {
    const found = driftOf(input([step('E5', { assumed: 'The app\'s page showing the download.' })], [trace('E5')]));
    expect(found.map((finding) => [finding.kind, finding.detail])).toEqual([['assumption', 'The app\'s page showing the download.']]);
  });
});
