import { describeProblem, MAX_TASK_DESCRIPTION, MAX_TASK_ROLE } from './tasks.js';
import type { NewTreeSpec, Plan, PlanBranch, PlanLeaf, PlanTask } from '@koala/harness-types';

export type { AdoptedPlan, NewTreeSpec, Plan, PlanBranch, PlanLeaf, PlanProposal, PlanStatus, PlanTask } from '@koala/harness-types';

export const MAX_PLAN_DOC = 40_000;
export const MAX_BRIEF = 12_000;

export interface PlanWorld {
  treeTypes: readonly string[];
  existingLeafIds: ReadonlySet<string>;
}

type Parsed = { plan: Plan } | { problem: string };

const text = (raw: Record<string, unknown>, key: string): string =>
  typeof raw[key] === 'string' ? (raw[key] as string).trim() : '';

const decoded = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
};

const list = (raw: Record<string, unknown>, key: string): unknown[] => {
  const value = decoded(raw[key]);
  return Array.isArray(value) ? value : [];
};

const notAList = (raw: Record<string, unknown>, key: string): boolean =>
  raw[key] !== undefined && !Array.isArray(decoded(raw[key]));

const names = (raw: Record<string, unknown>, key: string): string[] =>
  list(raw, key).filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim());

const record = (raw: unknown): Record<string, unknown> | undefined => {
  const value = decoded(raw);
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
};

function cycleIn(edges: ReadonlyMap<string, readonly string[]>): string[] | undefined {
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];

  const visit = (node: string): string[] | undefined => {
    if (state.get(node) === 'done') return undefined;
    if (state.get(node) === 'visiting') return [...path.slice(path.indexOf(node)), node];
    state.set(node, 'visiting');
    path.push(node);
    for (const next of edges.get(node) ?? []) {
      if (!edges.has(next)) continue;
      const found = visit(next);
      if (found) return found;
    }
    path.pop();
    state.set(node, 'done');
    return undefined;
  };

  for (const node of edges.keys()) {
    const found = visit(node);
    if (found) return found;
  }
  return undefined;
}

function parseTask(raw: unknown, leafKey: string, index: number): { task: PlanTask } | { problem: string } {
  const task = record(raw);
  if (!task) return { problem: `task ${index + 1} of leaf "${leafKey}" is not an object` };

  const key = text(task, 'key') || `t${index + 1}`;
  const title = text(task, 'title');
  const description = text(task, 'description');
  const role = text(task, 'role');
  const doneMeans = text(task, 'doneMeans') || text(task, 'done_means');
  const problem = describeProblem({ title, doneMeans, description, role, leafId: leafKey });
  if (problem) return { problem: `leaf "${leafKey}", task "${title || key}": ${problem}` };
  if (description.length > MAX_TASK_DESCRIPTION) return { problem: `leaf "${leafKey}", task "${title}": the description has to be under ${MAX_TASK_DESCRIPTION} characters` };
  if (role.length > MAX_TASK_ROLE) return { problem: `leaf "${leafKey}", task "${title}": the role has to be under ${MAX_TASK_ROLE} characters` };

  return {
    task: {
      key,
      title,
      description,
      role,
      doneMeans,
      dependsOn: names(task, 'dependsOn').concat(names(task, 'depends_on')),
    },
  };
}

function parseLeaf(raw: unknown, index: number): { leaf: PlanLeaf } | { problem: string } {
  const leaf = record(raw);
  if (!leaf) return { problem: `leaf ${index + 1} is not an object` };

  const title = text(leaf, 'title');
  const key = text(leaf, 'key') || title;
  const body = text(leaf, 'body') || text(leaf, 'goal');
  const brief = text(leaf, 'brief');
  if (!title) return { problem: `leaf ${index + 1} needs a title — the leaf in a few words` };
  if (!body) return { problem: `leaf "${title}" needs a body — the concrete end state a later judge checks: a name, a count, a behaviour you could inspect, not a verb phrase` };
  if (!brief) return { problem: `leaf "${title}" needs a brief — what whoever works it has to know: the approach, the files and services involved, what to watch out for. It is written into leaves/<leaf>.md for the agents that never met you` };
  if (brief.length > MAX_BRIEF) return { problem: `leaf "${title}": the brief has to be under ${MAX_BRIEF} characters` };

  const tasks: PlanTask[] = [];
  for (const [position, entry] of list(leaf, 'tasks').entries()) {
    const parsed = parseTask(entry, key, position);
    if ('problem' in parsed) return parsed;
    tasks.push(parsed.task);
  }

  const taskKeys = new Set<string>();
  for (const task of tasks) {
    if (taskKeys.has(task.key)) return { problem: `leaf "${title}" has two tasks keyed "${task.key}" — give each task its own key` };
    taskKeys.add(task.key);
  }
  for (const task of tasks) {
    const outside = task.dependsOn.filter((dependency) => !taskKeys.has(dependency));
    if (outside.length > 0) {
      return { problem: `leaf "${title}", task "${task.title}" waits on ${outside.join(', ')}, which is not a task of the same leaf. Work under a leaf only waits on work in that leaf; order between leaves belongs on the leaves' dependsOn` };
    }
  }
  const taskCycle = cycleIn(new Map(tasks.map((task) => [task.key, task.dependsOn])));
  if (taskCycle) return { problem: `leaf "${title}" has tasks waiting on each other in a circle: ${taskCycle.join(' → ')}` };

  return { leaf: { key, title, body, brief, dependsOn: names(leaf, 'dependsOn').concat(names(leaf, 'depends_on')), tasks } };
}

export function parsePlan(raw: Record<string, unknown>, world: PlanWorld): Parsed {
  const treeId = text(raw, 'treeId') || text(raw, 'tree_id');
  const treeRaw = record(raw.tree);
  let tree: NewTreeSpec | undefined;

  if (!treeId) {
    if (!treeRaw) return { problem: 'a plan names the tree it grows: treeId for an existing tree, or tree: { name, type, goal } for a new one' };
    const name = text(treeRaw, 'name');
    const type = text(treeRaw, 'type');
    const goal = text(treeRaw, 'goal');
    if (!name) return { problem: 'a new tree needs a name' };
    if (!world.treeTypes.includes(type)) {
      return { problem: `a new tree needs a type this person has: ${world.treeTypes.join(', ') || '(none are set up)'}${type ? ` — "${type}" is not one of them` : ''}` };
    }
    tree = { name, type, ...(goal ? { goal } : {}) };
  }

  const planDoc = text(raw, 'planDoc') || text(raw, 'plan_doc');
  if (!planDoc) return { problem: 'a plan needs a planDoc — the markdown that becomes PLAN.md: the goal, the approach, the assumptions you made and the questions still open' };
  if (planDoc.length > MAX_PLAN_DOC) return { problem: `the planDoc has to be under ${MAX_PLAN_DOC} characters` };

  if (notAList(raw, 'branches')) return { problem: 'branches has to be a list of { title, leaves } objects — it arrived as text that is not a JSON list' };

  const branches: PlanBranch[] = [];
  for (const [position, entry] of list(raw, 'branches').entries()) {
    const branch = record(entry);
    const title = branch ? text(branch, 'title') : '';
    if (!branch || !title) return { problem: `branch ${position + 1} needs a title — the direction in one line` };
    const leaves: PlanLeaf[] = [];
    for (const [index, leafEntry] of list(branch, 'leaves').entries()) {
      const parsed = parseLeaf(leafEntry, index);
      if ('problem' in parsed) return parsed;
      leaves.push(parsed.leaf);
    }
    branches.push({ title, leaves });
  }
  if (branches.length === 0) return { problem: 'a plan needs at least one branch — a direction the goal breaks into' };

  const allLeaves = branches.flatMap((branch) => branch.leaves);
  const leafKeys = new Set<string>();
  for (const leaf of allLeaves) {
    if (leafKeys.has(leaf.key)) return { problem: `two leaves are keyed "${leaf.key}" — give each leaf its own key so dependencies are unambiguous` };
    leafKeys.add(leaf.key);
  }
  for (const leaf of allLeaves) {
    const unknown = leaf.dependsOn.filter((dependency) => !leafKeys.has(dependency) && !world.existingLeafIds.has(dependency));
    if (unknown.length > 0) return { problem: `leaf "${leaf.title}" waits on ${unknown.join(', ')}, which is neither a leaf of this plan nor a leaf of the tree` };
  }
  const leafCycle = cycleIn(new Map(allLeaves.map((leaf) => [leaf.key, leaf.dependsOn])));
  if (leafCycle) return { problem: `leaves wait on each other in a circle: ${leafCycle.join(' → ')}` };

  return { plan: { ...(treeId ? { treeId } : {}), ...(tree ? { tree } : {}), planDoc, branches } };
}

export function planSummary(plan: Plan): string {
  const leaves = plan.branches.flatMap((branch) => branch.leaves);
  const tasks = leaves.reduce((sum, leaf) => sum + leaf.tasks.length, 0);
  const where = plan.tree ? `a new ${plan.tree.type} tree "${plan.tree.name}"` : `tree ${plan.treeId}`;
  return `${plan.branches.length} branch${plan.branches.length === 1 ? '' : 'es'}, ${leaves.length} lea${leaves.length === 1 ? 'f' : 'ves'}, ${tasks} task${tasks === 1 ? '' : 's'} for ${where}`;
}
