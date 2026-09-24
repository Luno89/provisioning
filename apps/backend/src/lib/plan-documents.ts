import type { AdoptedPlan, Plan, PlanLeaf } from './plan-proposals.js';

export const TREE_REPO = '/work/repo';
export const PLAN_DOC_PATH = 'PLAN.md';

export const leafBriefPath = (leafId: string): string => `leaves/${leafId}.md`;

export const leafWorktree = (leafId: string): string => `trees/${leafId}`;
export const judgeCheckout = (leafId: string): string => `judge/${leafId}`;
export const leafBranch = (leafId: string): string => `leaf/${leafId}`;

export interface LeafContext {
  planDoc: string;
  leafBrief: string;
  worktree: string;
  branch: string;
}

export const leafContext = (leafId: string): LeafContext => ({
  planDoc: PLAN_DOC_PATH,
  leafBrief: leafBriefPath(leafId),
  worktree: leafWorktree(leafId),
  branch: leafBranch(leafId),
});

export const leafContextLine = (leafId: string): string =>
  `leaf ${leafId}: work in ${leafWorktree(leafId)} on branch ${leafBranch(leafId)}; the plan is ${PLAN_DOC_PATH} and the leaf's brief is ${leafBriefPath(leafId)}, both at the top of that worktree — read them before changing anything`;

export interface PlanDocument {
  path: string;
  content: string;
}

const leafIdOf = (adopted: AdoptedPlan, key: string): string => adopted.leafIds[key] ?? key;

const taskIdOf = (adopted: AdoptedPlan, leafKey: string, taskKey: string): string =>
  adopted.taskIds[`${leafKey}/${taskKey}`] ?? taskKey;

function leafIndexLine(leaf: PlanLeaf, adopted: AdoptedPlan): string {
  const id = leafIdOf(adopted, leaf.key);
  const waits = leaf.dependsOn.length > 0
    ? ` — waits on ${leaf.dependsOn.map((dependency) => `\`${leafIdOf(adopted, dependency)}\``).join(', ')}`
    : '';
  const tasks = `${leaf.tasks.length} task${leaf.tasks.length === 1 ? '' : 's'}`;
  return `- **${leaf.title}** (\`${id}\`, ${tasks})${waits} — brief: [${leafBriefPath(id)}](${leafBriefPath(id)})`;
}

export function renderPlanDoc(plan: Plan, adopted: AdoptedPlan, treeName: string): string {
  const index = plan.branches.map((branch, position) => [
    `### ${branch.title}`,
    '',
    `Branch \`${adopted.branchIds[position] ?? ''}\``,
    '',
    ...branch.leaves.map((leaf) => leafIndexLine(leaf, adopted)),
  ].join('\n'));

  return [
    plan.planDoc.trim(),
    '',
    '---',
    '',
    `## The grove: ${treeName} (\`${adopted.treeId}\`)`,
    '',
    'Each leaf is a goal a judge checks; its brief says how to reach it and lists the tasks under it. Status lives on the board, not in these files.',
    '',
    ...index,
    '',
  ].join('\n');
}

export function renderLeafBrief(leaf: PlanLeaf, adopted: AdoptedPlan, branchTitle: string): string {
  const id = leafIdOf(adopted, leaf.key);
  const waits = leaf.dependsOn.length > 0
    ? leaf.dependsOn.map((dependency) => `\`${leafIdOf(adopted, dependency)}\``).join(', ')
    : 'nothing';

  const tasks = leaf.tasks.map((task) => {
    const taskId = taskIdOf(adopted, leaf.key, task.key);
    const after = task.dependsOn.length > 0
      ? `\n- **After:** ${task.dependsOn.map((dependency) => `\`${taskIdOf(adopted, leaf.key, dependency)}\``).join(', ')}`
      : '';
    return [
      `### ${task.title} (\`${taskId}\`)`,
      '',
      task.description,
      '',
      `- **Its part in the project:** ${task.role}`,
      `- **Done means:** ${task.doneMeans}${after}`,
    ].join('\n');
  });

  return [
    `# ${leaf.title}`,
    '',
    `Leaf \`${id}\` on branch "${branchTitle}" — the plan is in [../${PLAN_DOC_PATH}](../${PLAN_DOC_PATH}).`,
    '',
    '## The goal the judge checks',
    '',
    leaf.body,
    '',
    `Waits on: ${waits}`,
    '',
    '## Brief',
    '',
    leaf.brief,
    '',
    '## Tasks',
    '',
    ...(tasks.length > 0 ? [tasks.join('\n\n')] : ['None yet — this leaf is planned, not broken down.']),
    '',
  ].join('\n');
}

export function planDocuments(plan: Plan, adopted: AdoptedPlan, treeName: string): PlanDocument[] {
  return [
    { path: PLAN_DOC_PATH, content: renderPlanDoc(plan, adopted, treeName) },
    ...plan.branches.flatMap((branch) => branch.leaves.map((leaf) => ({
      path: leafBriefPath(leafIdOf(adopted, leaf.key)),
      content: renderLeafBrief(leaf, adopted, branch.title),
    }))),
  ];
}
