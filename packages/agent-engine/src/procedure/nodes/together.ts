import { defineNode } from '../definition.js';
import { stepImplementation, type BuiltInNode } from '../implementation.js';
import { describeError, type StepResult } from '../interpreter.js';

export const TOGETHER_KIND = 'together';

export interface Branch {
  node: string;
  after: string[];
}

export interface FailedBranch {
  branch: string;
  title: string;
  why: string;
}

type Ended = { ok: true } | { ok: false; why: string } | { stopped: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function branchesOf(settings: Readonly<Record<string, unknown>>): Branch[] {
  const listed = settings.branches;
  if (!Array.isArray(listed)) return [];
  return listed.filter(isRecord).map((entry) => ({
    node: typeof entry.node === 'string' ? entry.node : '',
    after: Array.isArray(entry.after) ? entry.after.filter((name): name is string => typeof name === 'string') : [],
  }));
}

function circle(branches: readonly Branch[]): string[] | undefined {
  const waitsOn = new Map(branches.map((entry) => [entry.node, entry.after]));
  const settled = new Set<string>();
  const walk = (name: string, path: readonly string[]): string[] | undefined => {
    if (settled.has(name)) return undefined;
    if (path.includes(name)) return [...path.slice(path.indexOf(name)), name];
    for (const before of waitsOn.get(name) ?? []) {
      const loop = before === name ? undefined : walk(before, [...path, name]);
      if (loop) return loop;
    }
    settled.add(name);
    return undefined;
  };
  for (const { node } of branches) {
    const loop = walk(node, []);
    if (loop) return loop;
  }
  return undefined;
}

export function branchProblems(branches: readonly Branch[]): string[] {
  const problems: string[] = [];
  const named = new Set<string>();
  for (const { node } of branches) {
    if (named.has(node)) problems.push(`runs "${node}" twice`);
    named.add(node);
  }
  for (const { node, after } of branches) {
    for (const before of after) {
      if (before === node) problems.push(`"${node}" waits on itself`);
      else if (!named.has(before)) problems.push(`"${node}" waits on "${before}", which is not one of its branches`);
    }
  }
  const loop = circle(branches);
  if (loop) problems.push(`its branches wait on each other in a circle (${loop.join(' → ')}), so none of them could start`);
  return problems;
}

function endedAs(result: StepResult): Ended {
  if ('interrupted' in result) return { stopped: result.interrupted };
  if ('finish' in result) return result.finish.outcome === 'ok' ? { ok: true } : { ok: false, why: result.finish.reason ?? `it finished ${result.finish.outcome}` };
  if (result.exit === 'done') return { ok: true };
  const reason = result.outputs?.reason;
  return { ok: false, why: typeof reason === 'string' && reason.trim() ? reason : `it left through "${result.exit}"` };
}

const failedOf = (ended: Ended): string | undefined => ('ok' in ended && !ended.ok ? ended.why : undefined);

export const together: BuiltInNode = {
  definition: defineNode({
    kind: TOGETHER_KIND,
    title: 'Together',
    category: 'control',
    describe: 'Runs several steps at once and waits until every one has ended. A step starts as soon as the steps it waits on have left through done; one that fails never stops the others, and a step waiting on it does not start. A branch step is named here and leads nowhere itself.',
    role: 'step',
    inputs: [],
    outputs: [
      { name: 'failed', type: 'json', describe: 'Every branch that did not come up: its step, title and why.' },
      { name: 'reason', type: 'text', describe: 'Every branch that did not come up, named with why.' },
    ],
    exits: [
      { name: 'done', describe: 'Every branch left through done.' },
      { name: 'failed', describe: 'One or more did not, once every branch had ended; failed and reason name each.' },
    ],
    settings: {
      type: 'object',
      required: ['branches'],
      properties: {
        branches: {
          type: 'array',
          title: 'Branches',
          default: [],
          items: {
            type: 'object',
            required: ['node'],
            properties: {
              node: { type: 'string', title: 'Step', minLength: 1 },
              after: { type: 'array', title: 'After', describe: 'The branches it waits on.', items: { type: 'string', minLength: 1 } },
            },
          },
        },
      },
    },
    runs: 'workflow',
    idempotent: false,
    summarize: (settings) => {
      const branches = branchesOf(settings);
      return branches.length > 0 ? `runs ${branches.map((entry) => entry.node).join(', ')} together` : 'runs nothing yet';
    },
    check: (settings) => branchProblems(branchesOf(settings)),
  }),
  implementation: stepImplementation(TOGETHER_KIND, async ({ node, branches: runs }) => {
    if (!runs) throw new Error(`"${node.id}" runs its branches only inside a procedure run`);
    const branches = branchesOf(node.settings);
    const problems = branchProblems(branches);
    if (problems.length > 0) throw new Error(`"${node.id}" ${problems.join('; ')}`);
    const ends = new Map<string, Promise<Ended>>();
    const endOf = (name: string): Promise<Ended> => {
      const known = ends.get(name);
      if (known) return known;
      const after = branches.find((entry) => entry.node === name)?.after ?? [];
      const ending = Promise.all(after.map(endOf)).then(async (before): Promise<Ended> => {
        const down = after.filter((_, at) => !('ok' in before[at]! && before[at].ok));
        if (down.length > 0) return { ok: false, why: `it did not start, since ${down.map(runs.title).join(' and ')} did not come up` };
        return runs.run(name).then(endedAs, (err: unknown): Ended => ({ ok: false, why: describeError(err) }));
      });
      ends.set(name, ending);
      return ending;
    };
    const ended = await Promise.all(branches.map((entry) => endOf(entry.node)));
    const stopped = ended.find((end): end is { stopped: string } => 'stopped' in end);
    if (stopped) return { interrupted: stopped.stopped };
    const failed: FailedBranch[] = branches.flatMap((entry, at) => {
      const why = failedOf(ended[at]!);
      return why === undefined ? [] : [{ branch: entry.node, title: runs.title(entry.node), why }];
    });
    if (failed.length === 0) return { exit: 'done', outputs: {} };
    return { exit: 'failed', outputs: { failed, reason: failed.map((entry) => `${entry.title}: ${entry.why}`).join('; ') } };
  }),
};
