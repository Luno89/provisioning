/**
 * The kanban board — agent harness Phase B (~/.claude/plans/agent-harness.md).
 *
 * The board is the STATE STORE, not a view over one. Each leaf in an active column maps to a
 * Temporal workflow; moving a leaf signals it. That single decision is what makes pause, retry and
 * reassign into workflow operations, and what makes agent runs survive a backend restart — which is
 * otherwise one of the hardest parts of building an agent system.
 *
 * This module is deliberately pure. Everything here is a rule about hierarchy, status or budget,
 * with no I/O, because these are the parts that are easy to get subtly wrong and expensive to
 * debug once real work is running through them.
 */

/**
 * Work states only. There is deliberately no 'backlog' or 'done':
 *
 * - A leaf exists because a request needed it, so there is no waiting-room to park it in. Work
 *   that is not wanted yet is a leaf that has not been created.
 * - 'done' duplicated `status: 'succeeded'`, and two sources of truth for completion drift. A
 *   finished leaf leaves the columns entirely rather than piling up in one.
 */
import type { WorkspaceLanguage } from './workspace-spec.js';
import type { AcceptanceCheck } from './acceptance.js';

export type LeafColumn = 'todo' | 'in-progress' | 'review';

/**
 * The columns, as a runtime value.
 *
 * The union type above validates nothing at a request boundary — `column` arrives as untrusted
 * JSON, so a removed column like 'done' was accepted with a 201 and written straight to the
 * database until this existed, leaving a leaf in a state the UI cannot render or move it out of.
 */
export const LEAF_COLUMNS: readonly LeafColumn[] = ['todo', 'in-progress', 'review'];

export function isLeafColumn(value: unknown): value is LeafColumn {
  return typeof value === 'string' && (LEAF_COLUMNS as readonly string[]).includes(value);
}

/**
 * Execution state, distinct from `column`. A leaf sits in a column because someone (or a persona)
 * put it there; its status reflects what the workflow actually did. Conflating them means a failed
 * run silently looks like work in progress.
 */
export type LeafStatus = 'proposed' | 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * A proposed leaf is a suggestion, not work.
 *
 * It has no workflow, consumes no budget, and does not appear in a column — the agent (or a
 * worker that found its own leaf too big) put it forward, and a human has not accepted it yet.
 * Modelled as a STATUS rather than a column because a proposal is not somewhere work sits; it is
 * work that does not exist yet. Starting a workflow for one would spend tokens on something
 * nobody agreed to.
 */
export function isProposed(leaf: Pick<Leaf, 'status'>): boolean {
  return leaf.status === 'proposed';
}

export interface Leaf {
  id: string;
  ownerId: string;
  /**
   * The branch this leaf grows on — one planning conversation.
   *
   * The scoping unit rather than a long-lived board, because that is what a leaf actually belongs
   * to: "add OAuth to my app" is a branch, and it grows leaves progressively as planning and
   * execution reveal more work. A board is a view over many branches, not the thing leaves hang off.
   */
  branchId: string;
  title: string;
  body?: string;
  column: LeafColumn;
  status: LeafStatus;

  /** Absent on a root leaf. */
  parentLeafId?: string;
  /** 0 for a root leaf. Capped — see MAX_DEPTH. */
  depth: number;
  /**
   * Whether the parent waits for this child.
   *
   * true  — "split this into three, then integrate": the parent's status derives from it.
   * false — "I found follow-up work": the child outlives the parent and never blocks it.
   */
  blocking: boolean;

  /**
   * Leaves that must SUCCEED before this one may start. Sibling ordering, not hierarchy.
   *
   * `parentLeafId` already expresses "this is part of that", and `blocking` expresses "the parent
   * waits" — but neither orders siblings, so a five-step plan fanned out and every step after the
   * first woke in an empty sandbox looking for work the previous one had done. Measured live:
   * "Create base GitHub API client" succeeded for 45,488 tokens, its sandbox was destroyed, and
   * the four leaves that depended on it each spent all 24 steps rebuilding it from nothing.
   *
   * A dependency is about ORDER, not about state transfer: sharing the work itself is what
   * `projectId` and the git checkout are for. Ordering without shared state just fails later.
   */
  dependsOn?: string[];

  /**
   * The branch this leaf pushed its work to, once the remote confirmed it.
   *
   * This is what makes `dependsOn` transfer state rather than only order it — a dependent leaf
   * clones and starts from these. Set from `git ls-remote`, never from the agent's report: an
   * outputBranch nothing can check out would strand every leaf that depends on it, which is worse
   * than having none.
   */
  outputBranch?: string;

  /**
   * A command that proves this leaf's work, run in the workspace when it finishes.
   *
   * Optional: absent means the language's default is used (the test suite the work itself
   * produced). See lib/leaf-verify.ts for why a model-authored command is not the default — a
   * leaf has no known solution to gate one against, so a trivially-true command would launder a
   * claim into a "verified" badge.
   */
  /**
   * Files this leaf is expected to leave behind, checked after it runs.
   *
   * The verification that works for research, docs and config — anything with no test suite to
   * run. It asks only whether the artifact is there, committed and non-empty; it makes no claim
   * about whether the contents are any good. See lib/leaf-artifacts.ts for why a filename is safe
   * to take from a planner when a verify COMMAND is not.
   */
  expects?: string[];

  /**
   * MCP servers this leaf needs to CALL while it runs, by name.
   *
   * ── WHY A LEAF AND NOT ONLY A PERSONA ──
   * `wantsMcp` read the persona alone, and a persona is written before anything is deployed — the
   * server's name is not knowable then. Measured: every persona on the instance had `scope.mcp: []`,
   * so no leaf could reach any MCP server at all, and a plan whose last stage was "call the deployed
   * server and verify real responses" had no way to do it.
   *
   * That is the loop this platform is for: Koala builds a service, and the next leaf uses it.
   * Declared per leaf because the leaf is the first thing that exists after the server does.
   *
   * Merged with the persona's, never replacing it — a persona that grants a server keeps granting
   * it, and a name that matches nothing running is reported rather than silently dropped.
   */
  mcp?: string[];

  verifyCommand?: string;


  /**
   * A research leaf's actual output, stored here rather than committed.
   *
   * The thing a research request was FOR. Kept on the record so it survives the workspace being
   * destroyed, is readable without cloning anything, and can be handed to dependent leaves as text.
   */
  findings?: string;

  /**
   * Whether anything actually checked the work, as opposed to the agent saying it was done.
   *
   * A `succeeded` leaf with this false is still a success — most leaves are not test-shaped — it
   * is just not evidence, and the board should not show the same tick for both.
   */
  verified?: boolean;

  /**
   * Whether the work reached the repository's default branch.
   *
   * False with `verified` true means the merge conflicted or was rejected — the work is intact on
   * `outputBranch` and needs a human. False with `verified` false is the ordinary case: nothing
   * checked it, so nothing landed it.
   */
  merged?: boolean;

  /**
   * What the agent reported when it finished — the leaf's actual output.
   *
   * Absent until now, which meant a leaf could run for two minutes, spend 144,000 tokens, report
   * success, and leave nothing behind to read. The activity returned this to the workflow, where
   * it landed in Temporal history and nowhere a person would look. "I don't see it doing anything"
   * was literally true of the board even though the work had happened.
   *
   * The agent's own claim, not a verified result — leaves have no verify command the way an
   * experiment task does, so this says what it believes it did.
   */
  summary?: string;

  personaId?: string;
  /**
   * The persona that will do this work, and therefore the whole environment it runs in.
   *
   * There used to be a `language` here as well, chosen per leaf. It stopped meaning anything when
   * the persona took over the image, leaving a stored field the planner could set and nothing
   * honoured. A plan that mixes a Go service with a Python script names a different persona for
   * each — "Builder (go)" and "Builder (python)" — which says the same thing in the one place that
   * decides it.
   */
  /** The Temporal workflow backing this leaf, once started. */
  workflowId?: string;
  projectId?: string;
  branch?: string;
  /** Root leaves only — the budget governing this leaf AND its whole subtree. */
  budget?: LeafBudget;

  /**
   * Every failed attempt at this leaf, oldest first.
   *
   * Kept rather than overwritten because the point of a retry is that the next attempt SEES why
   * the last one failed — see failureContext. A leaf that failed three different ways is a
   * different situation from one that failed the same way three times, and only the history
   * distinguishes them.
   */
  attempts?: LeafAttempt[];

  /**
   * Resources this leaf itself has consumed. Aggregated up to the root for budget checks —
   * see aggregateUsage. Absent means nothing recorded, never zero-and-final.
   */
  usage?: Partial<Omit<BudgetUsage, 'wallClockMs'>>;

  createdAt: string;
  updatedAt: string;
}

/**
 * Cost ceiling for a root leaf and everything beneath it.
 *
 * Deliberately on the ROOT rather than per leaf. Depth and fan-out caps alone still permit
 * 3 × 10 × 10 = 300 workspaces; only a subtree-wide budget actually bounds spend. It is also the
 * concrete mitigation for an injected "create 10,000 subtasks" — the prompt-injection risk in the
 * plan is not hypothetical once an agent reads a repo it did not write.
 */
export interface LeafBudget {
  maxTokens?: number;
  maxWallClockMs?: number;
  maxWorkspaces?: number;
  /** Replans count too. A planner that responds to failure by generating more work is a loop. */
  maxReplans?: number;
}

export interface BudgetUsage {
  tokens: number;
  wallClockMs: number;
  workspaces: number;
  replans: number;
}

/** A single failed run of a leaf. */
export interface LeafAttempt {
  /** 0-based. Attempt 0 is the first try, so `attempt: 2` means two prior failures. */
  attempt: number;
  error: string;
  failedAt: string;
}

/**
 * How many times a leaf is retried before it is failed for good.
 *
 * Deliberately small. Retrying an agent task is only useful because the next attempt is given the
 * previous failure; if three attempts with accumulating context cannot make progress, a fourth is
 * unlikely to, and each one costs real tokens and wall-clock against the root's budget.
 */
export const MAX_LEAF_ATTEMPTS = 3;

/**
 * What a leaf's status becomes when an attempt throws.
 *
 * ── WHAT THE BOARD SHOWED ──
 * Every attempt wrote `failed`, including ones with retries left. A leaf that failed twice and
 * succeeded on the third showed a red failed icon for most of its life, then flipped to verified at
 * the end. The UI was rendering the record faithfully — the record conflated "failed" with
 * "failed, trying again", which are not the same thing to anyone watching.
 *
 * The branch notice had the distinction all along ("and will retry" versus "will not be retried"),
 * so the conversation told the truth while the field the icon reads did not.
 *
 * The same distinction the rest of this codebase insists on — `failed` versus `unhealthy`,
 * `verified` versus `claimed` — missing from the state a person actually stares at.
 *
 * Nothing is hidden by this: `attempts` is written either way, and LeafDetail lists every failure
 * with its error, which is what makes a struggling leaf visible while it struggles.
 *
 * `attemptNumber` is Temporal's, counting from 1.
 */
export function statusAfterFailure(
  attemptNumber: number,
  maxAttempts = MAX_LEAF_ATTEMPTS,
): 'running' | 'failed' {
  return attemptNumber < maxAttempts ? 'running' : 'failed';
}

/**
 * Formats prior failures for injection into the next attempt's context.
 *
 * This is the whole reason retries are not Temporal's built-in retry policy: that replays the
 * SAME input, so an agent task would fail identically every time. Progress requires the next
 * attempt to know what went wrong.
 *
 * Returns an empty string for a first attempt so callers can append unconditionally.
 */
export function failureContext(attempts: LeafAttempt[] | undefined): string {
  if (!attempts?.length) return '';
  const lines = attempts.map((a) => `Attempt ${a.attempt + 1} failed: ${a.error}`);
  return [
    `This work has been attempted ${attempts.length} time(s) before and failed:`,
    ...lines,
    'Do not repeat the same approach. Address the failure above.',
  ].join('\n');
}

/** Whether another attempt is permitted. */
export function shouldRetry(failuresSoFar: number, max = MAX_LEAF_ATTEMPTS): boolean {
  return failuresSoFar < max;
}

/** Three levels is enough to express "epic → task → subtask" and stops runaway decomposition. */
export const MAX_DEPTH = 3;
/** Per-leaf fan-out. Combined with MAX_DEPTH this bounds the subtree; the budget bounds the cost. */
export const MAX_CHILDREN_PER_LEAF = 10;

/**
 * Why a child may not be added, or undefined if it may.
 *
 * Returns a reason rather than a boolean so the refusal can be shown to the user (and fed back to
 * the agent that asked), instead of a silent no-op that looks like the request was lost.
 */
export function canAddChild(parent: Pick<Leaf, 'depth'>, existingChildren: number): string | undefined {
  if (parent.depth + 1 > MAX_DEPTH) {
    return `Maximum nesting depth of ${MAX_DEPTH} reached — break the work down differently rather than deeper`;
  }
  if (existingChildren >= MAX_CHILDREN_PER_LEAF) {
    return `A leaf may have at most ${MAX_CHILDREN_PER_LEAF} sub-items`;
  }
  return undefined;
}

/** Why the budget is spent, or undefined if there is room. */
export function budgetExceeded(budget: LeafBudget | undefined, usage: BudgetUsage): string | undefined {
  if (!budget) return undefined;
  if (budget.maxTokens !== undefined && usage.tokens >= budget.maxTokens) {
    return `Token budget exhausted (${usage.tokens}/${budget.maxTokens})`;
  }
  if (budget.maxWallClockMs !== undefined && usage.wallClockMs >= budget.maxWallClockMs) {
    // Rounded to whole minutes, a short budget reads as "0 minutes", which sounds like a bug
    // rather than a limit. Scale the unit to the magnitude instead.
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

/**
 * A leaf's effective status, derived from its blocking children when it has any.
 *
 * Only BLOCKING children count. A non-blocking child is follow-up work that outlives its parent,
 * so letting it drag the parent back to "running" would mean a leaf could never finish.
 *
 * The leaf's own failure always wins: if the work it was doing itself failed, children succeeding
 * does not redeem it.
 */
export function deriveLeafStatus(own: LeafStatus, children: Pick<Leaf, 'status' | 'blocking'>[]): LeafStatus {
  // A proposed leaf's status is its own regardless of what hangs off it.
  if (own === 'proposed' || own === 'failed' || own === 'cancelled') return own;

  // Proposals are excluded: nobody has agreed to them, so a parent must not be held 'running' by
  // work that may never be accepted, nor marked failed by a suggestion.
  const blocking = children.filter((c) => c.blocking && c.status !== 'proposed');
  if (blocking.length === 0) return own;

  if (blocking.some((c) => c.status === 'failed')) return 'failed';
  if (blocking.some((c) => c.status === 'pending' || c.status === 'running')) return 'running';
  // Every blocking child finished. The parent is only done when its OWN work is too — otherwise a
  // leaf whose children raced ahead would report success while it had not started integrating.
  if (blocking.every((c) => c.status === 'cancelled')) return own === 'succeeded' ? 'succeeded' : 'cancelled';
  return own === 'succeeded' ? 'succeeded' : 'running';
}

/**
 * Deterministic Temporal workflow id for a child leaf.
 *
 * MUST be deterministic, and this is the single easiest thing to get wrong here. Activities retry;
 * a partially-succeeded "create subtask" step with random ids produces duplicate leaves AND
 * duplicate workspace pods. Deriving the id from (parent, index) makes Temporal's own workflow-id
 * dedup do the work — a retry addresses the same child rather than spawning a second.
 *
 * Index-based rather than content-hashed on purpose. A hash collides whenever a planner legitimately
 * emits two identically-titled subtasks ("write tests"), which is common. Index is safe because the
 * caller must record the planner's proposed children as an ACTIVITY RESULT first: Temporal persists
 * and replays that list identically, so the ordering cannot drift between attempts even though the
 * model that produced it is non-deterministic.
 */
export function childWorkflowId(parentLeafId: string, index: number): string {
  return `leaf-${parentLeafId}-child-${index}`;
}

/** Leaves whose parent is `parentId`, in stable creation order. */
export function childrenOf(leaves: Leaf[], parentId: string): Leaf[] {
  return leaves
    .filter((c) => c.parentLeafId === parentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * Walks up to the root leaf, which is where the budget lives.
 *
 * Returns undefined if the chain is broken (a parent id pointing at a leaf that no longer exists),
 * rather than looping — a cycle or dangling reference must not hang the caller.
 */
export function rootLeaf(leaves: Leaf[], leaf: Leaf): Leaf | undefined {
  const byId = new Map(leaves.map((c) => [c.id, c]));
  let current: Leaf | undefined = leaf;
  for (let i = 0; i <= MAX_DEPTH + 1 && current; i++) {
    if (!current.parentLeafId) return current;
    current = byId.get(current.parentLeafId);
  }
  return undefined;
}

/** Every descendant of a leaf, for aggregating usage against the root budget. */
export function subtreeOf(leaves: Leaf[], rootId: string): Leaf[] {
  const out: Leaf[] = [];
  const queue = [rootId];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue; // guards against a cycle rather than spinning forever
    seen.add(id);
    for (const child of leaves.filter((c) => c.parentLeafId === id)) {
      out.push(child);
      queue.push(child.id);
    }
  }
  return out;
}

/** Terminal states — a leaf here is no longer accruing wall-clock time. */
const FINISHED: readonly LeafStatus[] = ['succeeded', 'failed', 'cancelled'];

/**
 * Total resources consumed by a root leaf and its whole subtree.
 *
 * Wall-clock is measured from the ROOT's creation rather than summed across leaves, because
 * children run concurrently — summing their individual durations would count the same minutes
 * several times over and exhaust a time budget that had barely started.
 *
 * Tokens, workspaces and replans ARE summed, because those are genuinely consumed per leaf.
 *
 * `now` is injected rather than read from the clock so this stays pure and testable; a budget
 * check that silently depends on wall-clock time is miserable to write tests for.
 */
export function aggregateUsage(leaves: Leaf[], root: Leaf, now: number): BudgetUsage {
  const tree = [root, ...subtreeOf(leaves, root.id)];

  const sum = (field: keyof NonNullable<Leaf['usage']>): number =>
    tree.reduce((total, c) => total + (c.usage?.[field] ?? 0), 0);

  // A finished root stops the clock at its last update; a running one is still accruing.
  const start = Date.parse(root.createdAt);
  const end = FINISHED.includes(root.status) ? Date.parse(root.updatedAt) : now;
  const wallClockMs = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;

  return {
    tokens: sum('tokens'),
    workspaces: sum('workspaces'),
    replans: sum('replans'),
    wallClockMs,
  };
}

/** One turn of a conversation, stored on the branch. */
export interface BranchMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Reasoning is kept separately so it can be collapsed, and dropped first when trimming. */
  reasoning?: string;
  /**
   * Written by the system rather than said by anyone — a leaf failing, an acceptance check running.
   *
   * Carries the assistant role because `BranchMessage` has no system role and assistant is the
   * least wrong of the two: it renders as Koala reporting, and the next turn reads it as context it
   * already has rather than as an instruction. This flag is how the UI can tell the difference
   * without inferring it from the wording. See lib/branch-notice.ts.
   */
  notice?: boolean;
}

/**
 * A branch — one planning conversation, and the thing leaves hang off.
 *
 * Previously derived from the leaves referencing it, which meant a branch that had produced
 * nothing did not exist, its name was whatever its first leaf happened to be called, and the
 * transcript lived in React state that a single click discarded.
 */
export interface Branch {
  id: string;
  ownerId: string;
  /**
   * The tree this conversation belongs to.
   *
   * Optional while trees are being introduced: a branch created before them, or started from the
   * chat without picking one, has none and behaves exactly as it did. What it must never do is
   * point at a tree that does not exist, which is why the delete route clears it rather than
   * leaving a dangling id.
   */
  treeId?: string;
  /**
   * Whether well-formed proposals on this branch start without being asked.
   *
   * Off by default and per-branch rather than global: accepting work spends a model budget and runs
   * commands in a sandbox, so it is a decision about THIS effort. What counts as routine enough is
   * lib/auto-accept.ts, not this flag — this only says whether that policy runs at all.
   */
  autoAccept?: boolean;
  /** Derived from the first message unless renamed. */
  title: string;
  messages: BranchMessage[];
  /**
   * The ordered checks that decide whether this request actually delivered — run against the
   * assembled default branch once every leaf has finished.
   *
   * A LIST rather than one command, because "does it work" is rarely one question: a coding project
   * installs, tests, then runs; a research one checks the write-up exists and that its claims carry
   * sources. Each is named, because "the acceptance check failed" tells nobody which part broke.
   *
   * The bare-string form is what the first version stored and is still read — see
   * `usableAcceptancePlan`.
   *
   * Declared by the planner while planning, so it is visible in the conversation before anyone
   * accepts the work. That visibility is the safeguard, not the model's restraint: see
   * lib/acceptance.ts.
   */
  acceptance?: AcceptanceCheck[] | string;
  /** Set once the check has run, so one request produces one verdict rather than one per leaf. */
  acceptanceRunAt?: string;
  /**
   * The verdict itself.
   *
   * Previously the outcome existed only inside the notice written into the transcript — readable by
   * a person, and unavailable to anything that wanted to show whether the request actually
   * delivered. `unknown` is kept distinct from `failed` on purpose: "nobody knows" is worse than a
   * known failure and must never render as a pass.
   */
  acceptanceOutcome?: 'passed' | 'failed' | 'unknown';
  /** Which named check it stopped at, so the branch can say where rather than just that. */
  acceptanceFailedCheck?: string;
  createdAt: string;
  updatedAt: string;
}

/** Turns kept per branch. Beyond this the oldest are dropped — see trimTranscript. */
export const MAX_BRANCH_MESSAGES = 200;

/**
 * A title for a brand-new branch, taken from its first message.
 *
 * First USER message, not the first leaf: it is what the person actually asked for, available
 * immediately, and stable even if the decomposition is later rewritten. Naming a branch after its
 * first leaf made a branch and its only leaf read identically in the tree.
 */
export function deriveBranchTitle(firstMessage: string): string {
  const cleaned = (firstMessage ?? '')
    // Drop a leading slash command — "/plan add rate limiting" is titled "add rate limiting".
    .replace(/^\s*\/(chat|auto|plan)\b\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'New branch';
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}…` : cleaned;
}

/**
 * Keeps a transcript bounded.
 *
 * Drops the OLDEST turns: a long conversation's recent context is what matters, and an unbounded
 * transcript eventually makes the branch document too large to save. Reasoning is stripped from
 * everything but the last few turns first, since it is by far the biggest field and is almost
 * never re-read.
 */
export function trimTranscript(messages: BranchMessage[]): BranchMessage[] {
  const recent = messages.slice(-MAX_BRANCH_MESSAGES);
  const keepReasoningFrom = Math.max(0, recent.length - 6);
  return recent.map((m, i) =>
    i >= keepReasoningFrom ? m : (({ reasoning: _drop, ...rest }) => rest)(m),
  );
}

/* ── dependency ordering ──────────────────────────────────────────────────── */

/**
 * Whether every leaf this one waits on has succeeded.
 *
 * ── A DANGLING DEPENDENCY COUNTS AS MET ──
 * An id that resolves to nothing means the leaf it named was deleted, and there is no future in
 * which it succeeds. Treating that as unmet would strand the dependent forever with no way to
 * clear it by hand; treating it as met costs an ordering guarantee that was already lost when the
 * dependency was removed. The failure is loud either way, and this one is recoverable.
 *
 * A FAILED dependency is a different matter and is genuinely unmet: the work is still expected,
 * it just has not happened yet, and a retry can still satisfy it.
 */
export function dependenciesMet(leaf: Pick<Leaf, 'dependsOn'>, all: Leaf[]): boolean {
  return (leaf.dependsOn ?? []).every((id) => {
    const dep = all.find((l) => l.id === id);
    return !dep || dep.status === 'succeeded';
  });
}

/** The leaves actually holding this one up, for saying so rather than showing a silent queue. */
export function blockedBy(leaf: Pick<Leaf, 'dependsOn'>, all: Leaf[]): Leaf[] {
  return (leaf.dependsOn ?? [])
    .map((id) => all.find((l) => l.id === id))
    .filter((d): d is Leaf => d !== undefined && d.status !== 'succeeded');
}

/**
 * Accepted leaves whose turn has come — nothing started them yet and nothing is holding them back.
 *
 * `pending` is the resting state for a gated leaf rather than a new status: it already means
 * "accepted, not yet running", which is exactly true of one waiting its turn. A leaf that has a
 * workflow has already been started and must never be started twice.
 */
export function readyToStart(all: Leaf[]): Leaf[] {
  return all.filter((l) => l.status === 'pending' && !l.workflowId && dependenciesMet(l, all));
}

/**
 * Leaves waiting on this one — who to wake when it finishes.
 *
 * The counterpart to `blockedBy`, and the reason the release is an EVENT rather than a scan. The
 * board used to be swept every 30 seconds to re-derive readiness, which meant every edge in a plan
 * cost up to half a minute of nothing happening: a five-step chain spent about 75 seconds on
 * average waiting for a timer to come round, and the scan ran forever whether or not anything was
 * blocked.
 *
 * Deliberately NOT filtered by readiness. A leaf with two dependencies is woken by each of them and
 * decides for itself whether the last one has landed — the alternative is this caller evaluating a
 * DAG it only half-sees, and two dependencies finishing at once each concluding the other will do
 * it.
 */
export function dependentsOf(leafId: string, all: Leaf[]): Leaf[] {
  return all.filter((l) => (l.dependsOn ?? []).includes(leafId));
}

/**
 * Whether every leaf of a request has stopped moving.
 *
 * `proposed` does not count as outstanding: a proposal nobody accepted is not work in flight, and
 * waiting on one would mean a request never finishes because somebody declined a suggestion.
 */
export function requestFinished(leaves: Leaf[]): boolean {
  return !leaves.some((l) => l.status === 'pending' || l.status === 'running');
}

/**
 * Verified work that has not reached the default branch, oldest first.
 *
 * ── WHY THERE IS ANYTHING LEFT AT ALL ──
 * A leaf merges itself the moment it verifies, and for a chain that always works: each leaf
 * contains its predecessor, so every merge fast-forwards. Parallel leaves are the gap. Two branches
 * cut independently can touch the same file, and the second one's merge is abandoned rather than
 * forced — correctly, since resolving it would mean guessing. That work is then verified, intact,
 * and nowhere anybody looks.
 *
 * Ordered by creation so a later leaf's merge is attempted after the one it was probably built
 * beside, which is the order most likely to apply cleanly.
 */
export function unlandedWork(leaves: Leaf[]): Leaf[] {
  return leaves
    .filter((l) => l.status === 'succeeded' && l.verified === true && !l.merged && Boolean(l.outputBranch))
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
}

/**
 * Matches the TITLES a planner declared against leaves that exist, and says what it could not find.
 *
 * ── WHY TITLES AT ALL ──
 * The model proposes several leaves in one turn and cannot know the ids of the ones it created
 * seconds earlier, so asking for ids would produce guesses or nothing.
 *
 * ── WHY THE UNMATCHED ONES ARE RETURNED RATHER THAN DROPPED ──
 * They were dropped silently, and the tool reported plain success. Paraphrase your own title by one
 * word — which is exactly what a model does when it writes the same idea twice — and you have
 * declared a dependency chain, been told it worked, and actually built a fan-out where every step
 * starts at once. Nothing anywhere reported the difference.
 *
 * Still not an error: refusing a whole proposal over a spelling slip trades real work for a typo,
 * and the ordering was lost either way. The caller reports them instead, so the model can correct
 * itself on the next call.
 */
export interface ResolvedDependencies {
  ids: string[];
  /** Titles that matched nothing, exactly as they were given. */
  unresolved: string[];
}

/**
 * Case, surrounding whitespace, internal runs of whitespace, wrapping quotes and a trailing full
 * stop. Deliberately NOT fuzzy: matching approximately would attach the dependency to the wrong
 * leaf, which is silent and worse than reporting that nothing matched.
 */
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
    // A title named twice is one dependency, not two.
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids, unresolved };
}

/**
 * Whether adding these dependencies to `leafId` would close a cycle.
 *
 * Refused at proposal time rather than detected later: a cycle does not fail, it simply means
 * every leaf in it waits forever, which is indistinguishable from work that is merely slow.
 */
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
