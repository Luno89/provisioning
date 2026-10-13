import type { Leaf } from './leaves.js';
import type { Task } from '../engine-host/tools/tasks.js';
import { MAX_TITLE, newTask } from '../engine-host/tools/tasks.js';
import { leafIndexLine } from './plan-documents.js';
import { cycleIn, MAX_BRIEF, parseLeaf, parseTask, type ItemChange, type PlanLeaf, type PlanTask, type StoryEdit, type StorySnapshot } from './plan-proposals.js';

export interface ChangeWorld {
  treeId: string;
  leaves: readonly Leaf[];
  tasks: readonly Task[];
}

type Parsed = { change: ItemChange } | { problem: string };

const text = (raw: Record<string, unknown>, key: string): string | undefined =>
  typeof raw[key] === 'string' ? (raw[key] as string).trim() : undefined;

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

const listOf = (raw: Record<string, unknown>, key: string): unknown[] | undefined => {
  const value = decoded(raw[key]);
  return Array.isArray(value) ? value : undefined;
};

const idsOf = (raw: Record<string, unknown>, key: string): string[] | undefined =>
  listOf(raw, key)?.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim());

const quoted = (leaf: Pick<Leaf, 'title'>): string => `“${leaf.title}”`;

const namesOf = (leaves: readonly Leaf[], ids: Iterable<string>): Record<string, string> => {
  const names: Record<string, string> = {};
  for (const id of ids) {
    const leaf = leaves.find((entry) => entry.id === id);
    if (leaf) names[id] = leaf.title;
  }
  return names;
};

export const shippedProblem = (leaf: Pick<Leaf, 'id' | 'title'>): string =>
  `${quoted(leaf)} has shipped: its work is verified and landed, so it is not changed or reworked. Propose a follow-up story in its feature with propose_stories, waiting on ${leaf.id}`;

export function snapshotOf(leaf: Leaf, tasks: readonly Task[]): StorySnapshot {
  return {
    leafId: leaf.id,
    title: leaf.title,
    status: leaf.status,
    ...(leaf.body ? { body: leaf.body } : {}),
    dependsOn: [...(leaf.dependsOn ?? [])],
    tasks: tasks.filter((task) => task.leafId === leaf.id && task.status !== 'dropped').map((task) => ({ id: task.id, title: task.title, status: task.status })),
  };
}

const briefChanged = (leaf: Leaf, edit: StoryEdit): boolean =>
  (edit.title !== undefined && edit.title !== leaf.title)
  || (edit.body !== undefined && edit.body !== (leaf.body ?? ''))
  || edit.brief !== undefined;

const tasksChanged = (edit: StoryEdit): boolean => (edit.addTasks?.length ?? 0) > 0 || (edit.dropTasks?.length ?? 0) > 0;

export function restarts(leaf: Leaf, edit: StoryEdit): boolean {
  if (leaf.status === 'running') return briefChanged(leaf, edit) || edit.rework === true;
  if (leaf.status === 'claimed') return briefChanged(leaf, edit) || edit.rework === true || tasksChanged(edit);
  return leaf.status === 'failed' && edit.rework === true;
}

const waitsWithout = (leaves: readonly Leaf[], leafId: string, dependsOn: readonly string[]): Map<string, readonly string[]> =>
  new Map(leaves.map((leaf) => [leaf.id, leaf.id === leafId ? dependsOn : (leaf.dependsOn ?? [])]));

export function parseStoryEdit(raw: Record<string, unknown>, leafId: string, world: ChangeWorld): Parsed {
  const leaf = world.leaves.find((entry) => entry.id === leafId);
  if (!leaf) return { problem: `there is no story ${leafId} in this tree` };
  if (leaf.status === 'succeeded') return { problem: shippedProblem(leaf) };
  if (leaf.status === 'cancelled') return { problem: `${quoted(leaf)} was cancelled; propose a new story instead` };

  const why = text(raw, 'why');
  if (!why) return { problem: 'say why — what the person asked for or what showed this is needed; it goes on the card and into PLAN.md' };

  const title = text(raw, 'title');
  if (title !== undefined && !title) return { problem: 'a title cannot be empty — leave it out to keep the current one' };
  if (title && title.length > MAX_TITLE) return { problem: `a title has to be under ${MAX_TITLE} characters` };
  const body = text(raw, 'body') ?? text(raw, 'goal');
  if (body !== undefined && !body) return { problem: 'the goal cannot be empty — leave body out to keep the current one' };
  const brief = text(raw, 'brief');
  if (brief !== undefined && !brief) return { problem: 'the brief cannot be empty — leave it out to keep the current one' };
  if (brief && brief.length > MAX_BRIEF) return { problem: `the brief has to be under ${MAX_BRIEF} characters` };

  const own = world.tasks.filter((task) => task.leafId === leaf.id && task.status !== 'dropped');
  const dependsOn = idsOf(raw, 'dependsOn') ?? idsOf(raw, 'depends_on');
  if (dependsOn) {
    for (const id of dependsOn) {
      const other = world.leaves.find((entry) => entry.id === id);
      if (!other) return { problem: `${id} is not a story of this tree` };
      if (id === leaf.id) return { problem: 'a story cannot wait on itself' };
      if (other.status === 'cancelled') return { problem: `${quoted(other)} was cancelled, so nothing can wait on it` };
    }
    const cycle = cycleIn(waitsWithout(world.leaves, leaf.id, dependsOn));
    if (cycle) return { problem: `that makes stories wait on each other in a circle: ${cycle.join(' → ')}` };
  }

  const addTasks: PlanTask[] = [];
  for (const [index, entry] of (listOf(raw, 'addTasks') ?? listOf(raw, 'add_tasks') ?? []).entries()) {
    const parsed = parseTask(entry, leaf.id, index);
    if ('problem' in parsed) return parsed;
    addTasks.push(parsed.task);
  }
  const keys = new Set<string>();
  for (const task of addTasks) {
    if (keys.has(task.key)) return { problem: `two new tasks are keyed "${task.key}" — give each its own key` };
    keys.add(task.key);
  }
  for (const task of addTasks) {
    const outside = task.dependsOn.filter((dependency) => !keys.has(dependency) && !own.some((existing) => existing.id === dependency));
    if (outside.length > 0) return { problem: `task "${task.title}" waits on ${outside.join(', ')}, which is neither a new task nor one of this story's tasks` };
  }
  const taskCycle = cycleIn(new Map(addTasks.map((task) => [task.key, task.dependsOn])));
  if (taskCycle) return { problem: `the new tasks wait on each other in a circle: ${taskCycle.join(' → ')}` };

  const dropTasks = idsOf(raw, 'dropTasks') ?? idsOf(raw, 'drop_tasks') ?? [];
  for (const id of dropTasks) {
    if (!own.some((task) => task.id === id)) return { problem: `${id} is not one of this story's tasks` };
  }

  const rework = raw.rework === true || raw.rework === 'true';
  const edit: StoryEdit = {
    leafId: leaf.id,
    ...(title !== undefined && title !== leaf.title ? { title } : {}),
    ...(body !== undefined && body !== (leaf.body ?? '') ? { body } : {}),
    ...(brief !== undefined ? { brief } : {}),
    ...(dependsOn && dependsOn.join('\n') !== (leaf.dependsOn ?? []).join('\n') ? { dependsOn } : {}),
    ...(addTasks.length > 0 ? { addTasks } : {}),
    ...(dropTasks.length > 0 ? { dropTasks } : {}),
    ...(rework ? { rework } : {}),
  };
  if (Object.keys(edit).length === 1) return { problem: 'nothing would change — send what is different: title, body, brief, dependsOn, addTasks, dropTasks or rework' };
  if (rework && leaf.status === 'pending') return { problem: `${quoted(leaf)} has not been worked yet, so there is nothing to rework — change its brief and it is worked from that` };

  const restarting = restarts(leaf, edit);
  const busy = own.filter((task) => dropTasks.includes(task.id) && task.status === 'running');
  if (busy.length > 0 && !restarting) {
    return { problem: `${busy.map((task) => `"${task.title}"`).join(', ')} is being worked right now; add rework to stop the story and start it again without it` };
  }

  return {
    change: {
      treeId: world.treeId,
      why,
      edit,
      before: [snapshotOf(leaf, world.tasks)],
      outcome: editOutcome(leaf, edit, restarting),
      names: namesOf(world.leaves, [...(leaf.dependsOn ?? []), ...(dependsOn ?? [])]),
    },
  };
}

function editOutcome(leaf: Leaf, edit: StoryEdit, restarting: boolean): string[] {
  const lines: string[] = [];
  if (restarting && leaf.status === 'running') lines.push('The worker on it now is stopped, and the story starts again from this change. What it committed so far stays on its branch.');
  else if (restarting && leaf.status === 'claimed') lines.push('Its claim is set aside without a verdict, and the story starts again from this change.');
  else if (restarting) lines.push('It goes back to waiting and is worked again, from this change.');
  else if (leaf.status === 'failed') lines.push('It stays failed until it is retried: nothing starts. Ask for a rework to start it again now.');
  else if (leaf.status === 'running') lines.push('The worker on it carries on and picks up the new tasks.');
  else lines.push('It is still waiting; it is worked from this change the next time the tree runs.');
  if (edit.title || edit.body || edit.brief || edit.dependsOn || edit.addTasks || edit.dropTasks) {
    lines.push(`Its brief, leaves/${leaf.id}.md, is rewritten and PLAN.md notes the change, in the tree's repository.`);
  }
  if (restarting) lines.push('The tree is run once it is applied.');
  return lines;
}

export function parseNewStories(raw: Record<string, unknown>, branch: { id: string; title: string }, world: ChangeWorld): Parsed {
  const why = text(raw, 'why');
  if (!why) return { problem: 'say why — what the person asked for or what showed these are needed; it goes on the card and into PLAN.md' };
  const entries = listOf(raw, 'stories') ?? listOf(raw, 'leaves');
  if (!entries || entries.length === 0) return { problem: 'stories is a list of new stories, each { key, title, body, brief, dependsOn?, tasks? }' };

  const shared = idsOf(raw, 'dependsOn') ?? idsOf(raw, 'depends_on') ?? [];
  const leaves: PlanLeaf[] = [];
  for (const [index, entry] of entries.entries()) {
    const parsed = parseLeaf(entry, index);
    if ('problem' in parsed) return parsed;
    leaves.push({ ...parsed.leaf, dependsOn: [...new Set([...shared, ...parsed.leaf.dependsOn])] });
  }
  const keys = new Set<string>();
  for (const leaf of leaves) {
    if (keys.has(leaf.key)) return { problem: `two stories are keyed "${leaf.key}" — give each its own key` };
    keys.add(leaf.key);
  }
  for (const leaf of leaves) {
    for (const dependency of leaf.dependsOn) {
      if (keys.has(dependency)) continue;
      const existing = world.leaves.find((entry) => entry.id === dependency);
      if (!existing) return { problem: `story "${leaf.title}" waits on ${dependency}, which is neither a new story nor a story of this tree` };
      if (existing.status === 'cancelled') return { problem: `story "${leaf.title}" waits on ${quoted(existing)}, which was cancelled` };
    }
  }
  const cycle = cycleIn(new Map(leaves.map((leaf) => [leaf.key, leaf.dependsOn])));
  if (cycle) return { problem: `the new stories wait on each other in a circle: ${cycle.join(' → ')}` };

  const unplanned = leaves.filter((leaf) => leaf.tasks.length === 0).length;
  return {
    change: {
      treeId: world.treeId,
      why,
      add: { branchId: branch.id, branchTitle: branch.title, leaves },
      before: [],
      names: namesOf(world.leaves, leaves.flatMap((leaf) => leaf.dependsOn)),
      outcome: [
        leaves.length === 1
          ? `The story is added to “${branch.title}”, waiting, with its brief in leaves/ and listed in PLAN.md.`
          : `${leaves.length} stories are added to “${branch.title}”, waiting, each with its brief in leaves/ and listed in PLAN.md.`,
        ...(unplanned > 0 ? [`${unplanned === 1 ? 'One has' : `${unplanned} have`} no tasks yet: the planner breaks ${unplanned === 1 ? 'it' : 'them'} down first and asks you to approve each breakdown.`] : []),
        'The tree is run once they are added.',
      ],
    },
  };
}

export function parseCancel(raw: Record<string, unknown>, leafIds: readonly string[], world: ChangeWorld): Parsed {
  const why = text(raw, 'why');
  if (!why) return { problem: 'say why the story is no longer wanted; it goes on the card and into PLAN.md' };
  if (leafIds.length === 0) return { problem: 'say which stories to cancel (leafIds)' };

  const cancelled: Leaf[] = [];
  for (const id of new Set(leafIds)) {
    const leaf = world.leaves.find((entry) => entry.id === id);
    if (!leaf) return { problem: `there is no story ${id} in this tree` };
    if (leaf.status === 'succeeded') return { problem: `${quoted(leaf)} has shipped, so it cannot be cancelled; undoing what it did is a new story — propose_stories` };
    if (leaf.status === 'cancelled') return { problem: `${quoted(leaf)} is already cancelled` };
    cancelled.push(leaf);
  }
  const gone = new Set(cancelled.map((leaf) => leaf.id));
  const waiting = world.leaves.filter((leaf) => !gone.has(leaf.id) && leaf.status !== 'cancelled' && (leaf.dependsOn ?? []).some((id) => gone.has(id)));

  return {
    change: {
      treeId: world.treeId,
      why,
      cancel: cancelled.map((leaf) => leaf.id),
      before: cancelled.map((leaf) => snapshotOf(leaf, world.tasks)),
      names: namesOf(world.leaves, [...gone, ...waiting.map((leaf) => leaf.id)]),
      outcome: [
        ...cancelled.filter((leaf) => leaf.status === 'running').map((leaf) => `The worker on ${quoted(leaf)} is stopped.`),
        `${cancelled.length === 1 ? 'It is' : 'They are'} cancelled: kept on record, off the board's columns, never worked again.`,
        ...waiting.map((leaf) => `${quoted(leaf)} no longer waits on ${cancelled.filter((entry) => leaf.dependsOn?.includes(entry.id)).map(quoted).join(' or ')}.`),
        'PLAN.md notes the cancellation.',
      ],
    },
  };
}

export function runsToStop(change: ItemChange, leaves: readonly Leaf[]): string[] {
  const touched = [
    ...(change.edit ? [change.edit.leafId] : []),
    ...(change.cancel ?? []),
  ];
  return touched.flatMap((id) => {
    const leaf = leaves.find((entry) => entry.id === id);
    if (!leaf || leaf.status !== 'running' || !leaf.runId) return [];
    if (change.edit?.leafId === id && !change.cancel?.includes(id) && !restarts(leaf, change.edit)) return [];
    return [leaf.runId];
  });
}

export interface AppliedChange {
  leaves: Leaf[];
  tasks: Task[];
  leafIds: Record<string, string>;
  taskIds: Record<string, string>;
  grow: boolean;
}

export interface ApplyContext {
  proposalId: string;
  projectId?: string | undefined;
  at: string;
}

const reopened = (leaf: Leaf, error: string, context: ApplyContext): Leaf => {
  const attempts = leaf.attempts ?? [];
  const { claim: _claim, review: _review, runId, ...rest } = leaf;
  return {
    ...rest,
    status: 'pending',
    verified: false,
    attempts: [...attempts, { attempt: attempts.length + 1, error, failedAt: context.at, ...(runId ? { runId } : {}), change: context.proposalId }],
    updatedAt: context.at,
  };
};

export function applyChange(change: ItemChange, world: ChangeWorld, context: ApplyContext): AppliedChange {
  const out: AppliedChange = { leaves: [], tasks: [], leafIds: {}, taskIds: {}, grow: false };
  const idOf = (suffix: string) => `plan-${context.proposalId}-${suffix}`;

  if (change.edit) {
    const edit = change.edit;
    const leaf = world.leaves.find((entry) => entry.id === edit.leafId);
    if (!leaf) throw new Error(`story ${edit.leafId} no longer exists`);
    const done = (leaf.attempts ?? []).some((attempt) => attempt.change === context.proposalId);
    if (!done && leaf.status === 'succeeded') throw new Error(shippedProblem(leaf));
    if (!done && leaf.status === 'cancelled') throw new Error(`${quoted(leaf)} was cancelled since this was proposed`);

    const own = world.tasks.filter((task) => task.leafId === leaf.id);
    const restarting = !done && restarts(leaf, edit);
    for (const task of own) {
      if (edit.dropTasks?.includes(task.id) && task.status !== 'dropped') out.tasks.push({ ...task, status: 'dropped', updatedAt: context.at });
      else if (restarting && (task.status === 'running' || task.status === 'failed')) out.tasks.push({ ...task, status: 'accepted', updatedAt: context.at });
    }
    edit.addTasks?.forEach((task, index) => { out.taskIds[`${leaf.id}/${task.key}`] = idOf(`t${index}`); });
    for (const task of edit.addTasks ?? []) {
      const id = out.taskIds[`${leaf.id}/${task.key}`]!;
      if (own.some((existing) => existing.id === id)) continue;
      out.tasks.push({
        ...newTask({
          id,
          ownerId: leaf.ownerId,
          ...(context.projectId ? { projectId: context.projectId } : {}),
          leafId: leaf.id,
          title: task.title,
          description: task.description,
          role: task.role,
          doneMeans: task.doneMeans,
          ...(task.checks ? { checks: task.checks } : {}),
          dependsOn: task.dependsOn.map((dependency) => out.taskIds[`${leaf.id}/${dependency}`] ?? dependency),
        }, context.at),
        status: 'accepted',
      });
    }

    const kept = [
      ...own.filter((task) => task.status !== 'dropped' && !edit.dropTasks?.includes(task.id)).map((task) => task.id),
      ...out.tasks.filter((task) => task.leafId === leaf.id && !own.some((existing) => existing.id === task.id)).map((task) => task.id),
    ];
    const changed: Leaf = {
      ...leaf,
      ...(edit.title ? { title: edit.title } : {}),
      ...(edit.body ? { body: edit.body } : {}),
      ...(edit.dependsOn ? { dependsOn: [...edit.dependsOn] } : {}),
      tasks: kept,
      updatedAt: context.at,
    };
    const reason = leaf.status === 'failed'
      ? `reworked: ${change.why} — it had failed: ${leaf.findings ?? leaf.claim?.evidence ?? 'no reason was kept'}`
      : `stopped and started again: ${change.why}`;
    out.leaves.push(restarting ? reopened(changed, reason, context) : changed);
    out.grow = restarting || done;
  }

  if (change.add) {
    const add = change.add;
    add.leaves.forEach((leaf, l) => {
      out.leafIds[leaf.key] = idOf(`l${l}`);
      leaf.tasks.forEach((task, t) => { out.taskIds[`${leaf.key}/${task.key}`] = idOf(`l${l}-t${t}`); });
    });
    const ownerId = world.leaves[0]?.ownerId ?? '';
    for (const planLeaf of add.leaves) {
      const id = out.leafIds[planLeaf.key]!;
      if (world.leaves.some((entry) => entry.id === id)) continue;
      const tasks = planLeaf.tasks.map((task) => ({
        ...newTask({
          id: out.taskIds[`${planLeaf.key}/${task.key}`]!,
          ownerId,
          ...(context.projectId ? { projectId: context.projectId } : {}),
          leafId: id,
          title: task.title,
          description: task.description,
          role: task.role,
          doneMeans: task.doneMeans,
          ...(task.checks ? { checks: task.checks } : {}),
          dependsOn: task.dependsOn.map((dependency) => out.taskIds[`${planLeaf.key}/${dependency}`]!),
        }, context.at),
        status: 'accepted' as const,
      }));
      out.tasks.push(...tasks);
      const dependsOn = planLeaf.dependsOn.map((dependency) => out.leafIds[dependency] ?? dependency);
      out.leaves.push({
        id,
        ownerId,
        branchId: add.branchId,
        title: planLeaf.title,
        body: planLeaf.body,
        status: 'pending',
        tasks: tasks.map((task) => task.id),
        ...(dependsOn.length > 0 ? { dependsOn } : {}),
        createdAt: context.at,
        updatedAt: context.at,
      });
    }
    out.grow = true;
  }

  if (change.cancel) {
    const gone = new Set(change.cancel);
    for (const id of gone) {
      const leaf = world.leaves.find((entry) => entry.id === id);
      if (!leaf || leaf.status === 'cancelled') continue;
      if (leaf.status === 'succeeded') throw new Error(`${quoted(leaf)} shipped since this was proposed, so it cannot be cancelled`);
      const { runId: _runId, ...rest } = leaf;
      out.leaves.push({ ...rest, status: 'cancelled', findings: `Cancelled: ${change.why}`, updatedAt: context.at });
      for (const task of world.tasks.filter((entry) => entry.leafId === id && entry.status !== 'done' && entry.status !== 'dropped')) {
        out.tasks.push({ ...task, status: 'dropped', updatedAt: context.at });
      }
    }
    for (const leaf of world.leaves) {
      if (gone.has(leaf.id) || !(leaf.dependsOn ?? []).some((id) => gone.has(id))) continue;
      const already = out.leaves.find((entry) => entry.id === leaf.id) ?? leaf;
      const remaining = (already.dependsOn ?? []).filter((id) => !gone.has(id));
      const { dependsOn: _dependsOn, ...rest } = already;
      const updated: Leaf = { ...rest, ...(remaining.length > 0 ? { dependsOn: remaining } : {}), updatedAt: context.at };
      out.leaves = [...out.leaves.filter((entry) => entry.id !== leaf.id), updated];
    }
  }

  return out;
}

export function changeSummary(change: ItemChange, titleOf: (leafId: string) => string = (leafId) => change.before.find((story) => story.leafId === leafId)?.title ?? leafId): string {
  if (change.edit) {
    const edit = change.edit;
    return `${edit.rework && !edit.title && !edit.body && !edit.brief ? 'Rework' : 'Change'} “${edit.title ?? titleOf(edit.leafId)}”`;
  }
  if (change.add) return `Add ${change.add.leaves.length === 1 ? `“${change.add.leaves[0]!.title}”` : `${change.add.leaves.length} stories`} to “${change.add.branchTitle}”`;
  const cancelled = change.cancel ?? [];
  return `Cancel ${cancelled.length === 1 ? `“${titleOf(cancelled[0]!)}”` : `${cancelled.length} stories`}`;
}

export const BRIEF_SECTION = /\n## Brief\n\n([\s\S]*?)\n\n## Tasks\n/;

export function briefIn(document: string): string | undefined {
  return document.match(BRIEF_SECTION)?.[1]?.trim() || undefined;
}

export function withWaitsOn(document: string, dependsOn: readonly string[]): string {
  const line = `Waits on: ${dependsOn.length > 0 ? dependsOn.map((id) => `\`${id}\``).join(', ') : 'nothing'}`;
  return /^Waits on: .*$/m.test(document) ? document.replace(/^Waits on: .*$/m, line) : document;
}

export function renderChangeNote(earlier: string, change: ItemChange, applied: Pick<AppliedChange, 'leafIds' | 'taskIds'>, proposalId: string, titleOf: (leafId: string) => string): string {
  const lines: string[] = [];
  if (change.edit) {
    const edit = change.edit;
    const parts = [
      edit.title ? `renamed from “${change.before[0]?.title ?? ''}”` : '',
      edit.body ? 'its goal changed' : '',
      edit.brief ? 'its brief rewritten' : '',
      edit.dependsOn ? `it now waits on ${edit.dependsOn.length > 0 ? edit.dependsOn.map((id) => `\`${id}\``).join(', ') : 'nothing'}` : '',
      edit.addTasks?.length ? `${edit.addTasks.length} task${edit.addTasks.length === 1 ? '' : 's'} added` : '',
      edit.dropTasks?.length ? `${edit.dropTasks.length} task${edit.dropTasks.length === 1 ? '' : 's'} dropped` : '',
      edit.rework ? 'sent back to be worked again' : '',
    ].filter(Boolean);
    lines.push(`- **${titleOf(edit.leafId)}** (\`${edit.leafId}\`): ${parts.join('; ')} — brief: [leaves/${edit.leafId}.md](leaves/${edit.leafId}.md)`);
  }
  if (change.add) {
    const adopted = { treeId: change.treeId, branchIds: [change.add.branchId], leafIds: applied.leafIds, taskIds: applied.taskIds };
    lines.push(`Added to “${change.add.branchTitle}” (branch \`${change.add.branchId}\`):`, '', ...change.add.leaves.map((leaf) => leafIndexLine(leaf, adopted)));
  }
  for (const id of change.cancel ?? []) lines.push(`- **${titleOf(id)}** (\`${id}\`): cancelled`);
  return [
    earlier.trimEnd(),
    '',
    '---',
    '',
    `## Changed: ${changeSummary(change, (leafId) => change.before.find((story) => story.leafId === leafId)?.title ?? titleOf(leafId))} (change \`${proposalId}\`)`,
    '',
    change.why,
    '',
    ...lines,
    '',
  ].join('\n');
}
