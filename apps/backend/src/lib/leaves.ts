
import type { WorkspaceLanguage } from './workspace-spec.js';
import type { AcceptanceCheck } from './acceptance.js';
import type { ValidationRecipe } from './tree-types.js';

export type LeafColumn = 'todo' | 'in-progress' | 'review';

export const LEAF_COLUMNS: readonly LeafColumn[] = ['todo', 'in-progress', 'review'];

export function isLeafColumn(value: unknown): value is LeafColumn {
  return typeof value === 'string' && (LEAF_COLUMNS as readonly string[]).includes(value);
}

export type LeafStatus = 'proposed' | 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export function isProposed(leaf: Pick<Leaf, 'status'>): boolean {
  return leaf.status === 'proposed';
}

export interface Leaf {
  id: string;
  ownerId: string;
  branchId: string;
  title: string;
  body?: string;
  column: LeafColumn;
  status: LeafStatus;

  parentLeafId?: string;
  depth: number;
  blocking: boolean;

  dependsOn?: string[];

  outputBranch?: string;

  expects?: string[];

  mcp?: string[];

  verifyCommand?: string;

  validationContract?: ValidationRecipe | undefined;

  findings?: string;

  verified?: boolean;

  checks?: import('./leaf-trace.js').LeafChecks;

  review?: {
    verdict: 'sound' | 'concern' | 'unsound' | 'unavailable';
    dimensions?: { name: string; verdict: string; quote: string; why: string }[];
    model?: string;
    at: string;
    reason?: string;
  };

  merged?: boolean;

  summary?: string;

  packId?: string;

  workflowId?: string;
  projectId?: string;
  branch?: string;
  budget?: LeafBudget;

  attempts?: LeafAttempt[];

  usage?: Partial<Omit<BudgetUsage, 'wallClockMs'>>;

  createdAt: string;
  updatedAt: string;
}

export interface LeafBudget {
  maxTokens?: number;
  maxWallClockMs?: number;
  maxWorkspaces?: number;
  maxReplans?: number;
}

export interface BudgetUsage {
  tokens: number;
  completionTokens: number;
  wallClockMs: number;
  workspaces: number;
  replans: number;
}

export interface LeafAttempt {
  attempt: number;
  error: string;
  failedAt: string;
  produced?: boolean;
}

export function barrenStreak(priorAttempts: LeafAttempt[], producedThisTime: boolean): boolean {
  if (producedThisTime) return false;
  const last = priorAttempts[priorAttempts.length - 1];
  return last?.produced === false;
}

export const MAX_LEAF_ATTEMPTS = 3;

export function statusAfterFailure(
  attemptNumber: number,
  maxAttempts = MAX_LEAF_ATTEMPTS,
): 'running' | 'failed' {
  return attemptNumber < maxAttempts ? 'running' : 'failed';
}

export function failureContext(attempts: LeafAttempt[] | undefined): string {
  if (!attempts?.length) return '';
  const lines = attempts.map((a) => `Attempt ${a.attempt + 1} failed: ${a.error}`);
  return [
    `This work has been attempted ${attempts.length} time(s) before and failed:`,
    ...lines,
    'Do not repeat the same approach. Address the failure above.',
  ].join('\n');
}

export function shouldRetry(failuresSoFar: number, max = MAX_LEAF_ATTEMPTS): boolean {
  return failuresSoFar < max;
}

export const MAX_DEPTH = 3;
export const MAX_CHILDREN_PER_LEAF = 10;

export function canAddChild(parent: Pick<Leaf, 'depth'>, existingChildren: number): string | undefined {
  if (parent.depth + 1 > MAX_DEPTH) {
    return `Maximum nesting depth of ${MAX_DEPTH} reached — break the work down differently rather than deeper`;
  }
  if (existingChildren >= MAX_CHILDREN_PER_LEAF) {
    return `A leaf may have at most ${MAX_CHILDREN_PER_LEAF} sub-items`;
  }
  return undefined;
}

export function budgetExceeded(budget: LeafBudget | undefined, usage: BudgetUsage): string | undefined {
  if (!budget) return undefined;
  if (budget.maxTokens !== undefined && usage.tokens >= budget.maxTokens) {
    return `Token budget exhausted (${usage.tokens}/${budget.maxTokens})`;
  }
  if (budget.maxWallClockMs !== undefined && usage.wallClockMs >= budget.maxWallClockMs) {
    const ms = usage.wallClockMs;
    const elapsed = ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${(ms / 1000).toFixed(1)} seconds`;
    return `Time budget exhausted (${elapsed})`;
  }
  if (budget.maxWorkspaces !== undefined && usage.workspaces >= budget.maxWorkspaces) {
    return `Workspace budget exhausted (${usage.workspaces}/${budget.maxWorkspaces})`;
  }
  if (budget.maxReplans !== undefined && usage.replans >= budget.maxReplans) {
    return `Replan budget exhausted (${usage.replans}/${budget.maxReplans}) — the plan is not converging`;
  }
  return undefined;
}

export function deriveLeafStatus(own: LeafStatus, children: Pick<Leaf, 'status' | 'blocking'>[]): LeafStatus {
  if (own === 'proposed' || own === 'failed' || own === 'cancelled') return own;

  const blocking = children.filter((c) => c.blocking && c.status !== 'proposed');
  if (blocking.length === 0) return own;

  if (blocking.some((c) => c.status === 'failed')) return 'failed';
  if (blocking.some((c) => c.status === 'pending' || c.status === 'running')) return 'running';
  if (blocking.every((c) => c.status === 'cancelled')) return own === 'succeeded' ? 'succeeded' : 'cancelled';
  return own === 'succeeded' ? 'succeeded' : 'running';
}

export function childWorkflowId(parentLeafId: string, index: number): string {
  return `leaf-${parentLeafId}-child-${index}`;
}

export function childrenOf(leaves: Leaf[], parentId: string): Leaf[] {
  return leaves
    .filter((c) => c.parentLeafId === parentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function rootLeaf(leaves: Leaf[], leaf: Leaf): Leaf | undefined {
  const byId = new Map(leaves.map((c) => [c.id, c]));
  let current: Leaf | undefined = leaf;
  for (let i = 0; i <= MAX_DEPTH + 1 && current; i++) {
    if (!current.parentLeafId) return current;
    current = byId.get(current.parentLeafId);
  }
  return undefined;
}

export function subtreeOf(leaves: Leaf[], rootId: string): Leaf[] {
  const out: Leaf[] = [];
  const queue = [rootId];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const child of leaves.filter((c) => c.parentLeafId === id)) {
      out.push(child);
      queue.push(child.id);
    }
  }
  return out;
}

const FINISHED: readonly LeafStatus[] = ['succeeded', 'failed', 'cancelled'];

export function aggregateUsage(leaves: Leaf[], root: Leaf, now: number): BudgetUsage {
  const tree = [root, ...subtreeOf(leaves, root.id)];

  const sum = (field: keyof NonNullable<Leaf['usage']>): number =>
    tree.reduce((total, c) => total + (c.usage?.[field] ?? 0), 0);

  const start = Date.parse(root.createdAt);
  const end = FINISHED.includes(root.status) ? Date.parse(root.updatedAt) : now;
  const wallClockMs = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;

  return {
    tokens: sum('tokens'),
    completionTokens: sum('completionTokens'),
    workspaces: sum('workspaces'),
    replans: sum('replans'),
    wallClockMs,
  };
}

export interface BranchMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  notice?: boolean;
}

export interface Branch {
  id: string;
  ownerId: string;
  treeId?: string;
  autoAccept?: boolean;
  title: string;
  messages: BranchMessage[];
  acceptance?: AcceptanceCheck[] | string;
  acceptanceRunAt?: string;
  acceptanceOutcome?: 'passed' | 'failed' | 'unknown';
  acceptanceFailedCheck?: string;
  createdAt: string;
  updatedAt: string;
}

export const MAX_BRANCH_MESSAGES = 200;

export function deriveBranchTitle(firstMessage: string): string {
  const cleaned = (firstMessage ?? '')
    .replace(/^\s*\/(chat|auto|plan)\b\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'New branch';
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}…` : cleaned;
}

export function trimTranscript(messages: BranchMessage[]): BranchMessage[] {
  const recent = messages.slice(-MAX_BRANCH_MESSAGES);
  const keepReasoningFrom = Math.max(0, recent.length - 6);
  return recent.map((m, i) =>
    i >= keepReasoningFrom ? m : (({ reasoning: _drop, ...rest }) => rest)(m),
  );
}

export function dependenciesMet(leaf: Pick<Leaf, 'dependsOn'>, all: Leaf[]): boolean {
  return (leaf.dependsOn ?? []).every((id) => {
    const dep = all.find((l) => l.id === id);
    return !dep || dep.status === 'succeeded';
  });
}

export function blockedBy(leaf: Pick<Leaf, 'dependsOn'>, all: Leaf[]): Leaf[] {
  return (leaf.dependsOn ?? [])
    .map((id) => all.find((l) => l.id === id))
    .filter((d): d is Leaf => d !== undefined && d.status !== 'succeeded');
}

export function readyToStart(all: Leaf[]): Leaf[] {
  return all.filter((l) => l.status === 'pending' && !l.workflowId && dependenciesMet(l, all));
}

export function dependentsOf(leafId: string, all: Leaf[]): Leaf[] {
  return all.filter((l) => (l.dependsOn ?? []).includes(leafId));
}

export function requestFinished(leaves: Leaf[]): boolean {
  return !leaves.some((l) => l.status === 'pending' || l.status === 'running');
}

export function unlandedWork(leaves: Leaf[]): Leaf[] {
  return leaves
    .filter((l) => l.status === 'succeeded' && l.verified === true && !l.merged && Boolean(l.outputBranch))
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
}

export interface ResolvedDependencies {
  ids: string[];
  unresolved: string[];
}

function normaliseTitle(title: string): string {
  return title.trim().toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\.$/, '');
}

export function resolveDependencyTitles(titles: string[], all: Leaf[]): ResolvedDependencies {
  const byTitle = new Map(all.map((l) => [normaliseTitle(l.title), l.id]));
  const ids: string[] = [];
  const unresolved: string[] = [];

  for (const title of titles) {
    const id = byTitle.get(normaliseTitle(title));
    if (!id) { unresolved.push(title); continue; }
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids, unresolved };
}

export function wouldCycle(leafId: string, dependsOn: string[], all: Leaf[]): boolean {
  const edges = new Map(all.map((l) => [l.id, l.dependsOn ?? []]));
  edges.set(leafId, dependsOn);

  const seen = new Set<string>();
  const stack = [...dependsOn];
  while (stack.length) {
    const next = stack.pop()!;
    if (next === leafId) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(edges.get(next) ?? []));
  }
  return false;
}
