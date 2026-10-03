import type { ToolDefinition } from '@koala/agent-engine';

const PLAN_TASK = {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'A short key for the task, unique within its leaf, for dependsOn.' },
    title: { type: 'string', description: 'What the task is, in a line.' },
    description: { type: 'string', description: 'What will actually be done, end to end — not a restatement of the title.' },
    role: { type: 'string', description: 'The part it plays in the project: which goal it serves and what it makes possible.' },
    doneMeans: { type: 'string', description: 'How anyone can tell it worked, without reading your mind.' },
    dependsOn: { type: 'array', items: { type: 'string' }, description: 'Keys of tasks in the same leaf that must finish first.' },
    checks: { type: 'object', description: 'What code can check when the task is done, run before any judge is asked — so only add what a command can settle, not what needs reading. fileExists: a path that must exist and not be empty. contentPath + contentPattern: a regular expression that file must match. command + expects: a command that must exit clean and whose output must contain each of these strings. httpUrl + httpStatus: an endpoint that must answer, with that status (default 200).' },
  },
  required: ['key', 'title', 'description', 'role', 'doneMeans'],
};

const PLAN_LEAF = {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'A short key for the leaf, unique within the plan, for dependsOn.' },
    title: { type: 'string', description: 'The leaf in a few words.' },
    body: { type: 'string', description: 'The concrete end state a later judge checks: a name, a count, a behaviour you could inspect — not a verb phrase.' },
    brief: { type: 'string', description: 'Markdown for leaves/<leaf>.md: what whoever works this leaf must know — approach, files and services involved, pitfalls.' },
    dependsOn: { type: 'array', items: { type: 'string' }, description: 'Keys of leaves in this plan, or ids of the tree\'s existing leaves, that must succeed first.' },
    tasks: { type: 'array', items: PLAN_TASK, description: 'The briefed tasks that get the leaf done. May be empty: a leaf planned but not yet broken down.' },
  },
  required: ['key', 'title', 'body', 'brief'],
};

/**
 * Engine tools for shaping a Grove tree: branches and leaves. Tasks under a leaf belong to
 * propose_work; this catalogue is the other half of the planner's hands.
 */
export const GROVE_TOOLS: ToolDefinition[] = [
  {
    name: 'propose_leaf_plan',
    summary: 'Propose new tasks for one leaf — a replan after it failed, or the breakdown of a leaf with no tasks — for the person to approve',
    guidance: 'Plans one leaf, not a tree. For a replan, read what failed first (the failure you were handed, the leaf brief and PLAN.md, and the work committed in the worktree you are in) and propose tasks that get past it; amend the goal only if the failure shows the goal itself was wrong, and say so in why. For a breakdown, propose the tasks that reach the goal as it stands. The proposal waits for the person; approving replaces the leaf\'s unfinished tasks with these and runs the tree again.',
    binding: 'platform',
    effect: 'write',
    idempotent: false,
    openWorld: false,
    returns: 'text in the form `proposed leaf plan <id> — <mode> of "<leaf>": <n> tasks`',
    failures: [
      { when: 'the plan is incomplete', says: 'the first thing to fix, and that nothing was saved' },
      { when: 'the leaf belongs to a frozen legacy tree', says: 'that new work goes into a new tree' },
    ],
    parameters: {
      type: 'object',
      properties: {
        leafId: { type: 'string', description: 'The leaf this plan is for.' },
        mode: { type: 'string', enum: ['replan', 'breakdown'], description: 'replan: the leaf failed. breakdown: the leaf has no tasks yet.' },
        why: { type: 'string', description: 'For a replan: what the failure showed and why these tasks get past it. For a breakdown: how the tasks reach the goal.' },
        body: { type: 'string', description: 'An amended goal — only when the failure shows the goal itself was wrong.' },
        brief: { type: 'string', description: 'The new brief for leaves/<leaf>.md: approach, files and services involved, what the last attempt taught.' },
        tasks: { type: 'array', items: PLAN_TASK, description: 'The tasks to work next, each with key, title, description, role, doneMeans and same-leaf dependsOn.' },
      },
      required: ['leafId', 'mode', 'why', 'brief', 'tasks'],
    },
  },
  {
    name: 'read_tree',
    summary: 'Read what a Grove tree already holds: its goal, branches, and each leaf with its id, state, tasks and what it waits on',
    guidance: 'Read the tree before planning more of it, so a plan grows what is there instead of repeating it: new leaves can wait on existing leaf ids. In a conversation about one tree, treeId may be left out.',
    binding: 'platform',
    effect: 'read',
    idempotent: true,
    openWorld: false,
    returns: 'the tree\'s name, id, type and goal, then each branch with its leaves as `<title> (<id>) [<status>, <done>/<n> tasks done, waits on …] — <goal>`',
    failures: [
      { when: 'the tree is not yours or does not exist', says: 'no such tree' },
      { when: 'no treeId is given and the conversation is about no tree', says: 'that it needs the treeId' },
    ],
    parameters: {
      type: 'object',
      properties: {
        treeId: { type: 'string', description: 'The tree to read. Optional in a conversation about one tree.' },
      },
    },
  },
  {
    name: 'list_tree_types',
    summary: 'List the kinds of project a new tree can be, with what each is for',
    guidance: 'Check this before proposing a new tree: the tree type decides how the project is built and judged, and only these ids are accepted.',
    binding: 'platform',
    effect: 'read',
    idempotent: true,
    openWorld: false,
    returns: 'one line per type: `<id> — <label>: <summary>`',
    failures: [{ when: 'no tree types are set up', says: 'that no new tree can be proposed' }],
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'propose_plan',
    summary: 'Propose a whole Grove plan for the person to approve: branches, leaves with checkable goals and briefs, and the briefed tasks under each',
    guidance: 'The planner\'s one hand for a tree. Send the whole plan in one call; it is checked all at once and, if anything is missing, refused with what to fix and nothing saved. A valid plan is kept as a proposal and shown to the person with Approve and Reject — nothing exists in the grove until they approve. Approval creates the tree (when you describe a new one), its branches, leaves and tasks, the tree\'s sandbox, PLAN.md from your planDoc, and leaves/<leaf>.md from each brief; those documents are what every later agent works from, so write them for someone who never met you.',
    binding: 'platform',
    effect: 'write',
    idempotent: false,
    openWorld: false,
    returns: 'text in the form `proposed plan <id> — <n> branches, <n> leaves, <n> tasks for <tree>`',
    failures: [
      { when: 'the plan is incomplete or inconsistent', says: 'the first thing to fix, and that nothing was saved' },
      { when: 'treeId names a tree that is not yours or does not exist', says: 'no such tree, and how to start a new one instead' },
    ],
    parameters: {
      type: 'object',
      properties: {
        treeId: { type: 'string', description: 'An existing tree to grow. Leave out to start a new one with tree.' },
        tree: {
          type: 'object',
          description: 'A new tree, when there is no treeId: { name, type, goal, serviceName } — type is one of the person\'s tree types; serviceName, when the tree produces a service others will call, is one or two words like weather, and prefixes every tool that service exposes.',
        },
        planDoc: { type: 'string', description: 'Markdown for PLAN.md with three headed sections — ## Destination, ## Not yet specified (fog, including every unchecked fact the plan rests on), ## Out of scope — plus the approach.' },
        branches: {
          type: 'array',
          description: 'The directions the goal breaks into, each with its leaves.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'The direction in one line.' },
              leaves: { type: 'array', items: PLAN_LEAF },
            },
            required: ['title', 'leaves'],
          },
        },
      },
      required: ['planDoc', 'branches'],
    },
  },
  {
    name: 'claim_leaf',
    summary: 'The executor’s hand: file the claim on a worked leaf — evidence for the judge, or a failed claim with the reason',
    guidance: 'Work has a terminal word, and it is not your verdict. result “claimed”: the leaf’s tasks are done and here is the evidence — write it as pointers the judge can re-derive, not prose (commands with their output, file paths, run ids); findings flags concerns for the judge. result “failed”: the work is blocked beyond your power — a reason is required (what is blocked, what you tried, why it is beyond you). A claim moves the leaf to claimed/failed and never past that: the judge, in the judge pass, weighs the evidence against the leaf’s goal and settles it. A proposed (unaccepted) leaf, an already-claimed leaf, and a settled leaf are all refused — each with the state it is in and what comes next.',
    binding: 'platform',
    effect: 'write',
    idempotent: false,
    openWorld: false,
    returns: 'text in the form `claimed <leafId>` / `failed <leafId> — <reason>`; the leaf carries the claim record (evidence, findings, runs, at) for the judge',
    failures: [
      { when: 'result is missing, or a success word', says: 'what the result may be, and that the work does not grade itself' },
      { when: 'evidence is blank', says: 'what evidence is, and where it has to point (the leaf’s workspace repo and recorded output — the judge re-derives from those on the same build)' },
      { when: 'the failed claim has no reason', says: 'what a reason must carry' },
      { when: 'the leaf is unknown, proposed, already claimed, or settled', says: 'which leaf, which state it is in, and what comes next from it' },
    ],
    parameters: {
      type: 'object',
      properties: {
        leafId: { type: 'string', description: 'The leaf the work was done under.' },
        result: { type: 'string', enum: ['claimed', 'failed'], description: 'claimed — the tasks are done; failed — the work is blocked beyond this run’s power.' },
        evidence: { type: 'string', description: 'What was run and what it showed — file paths, commits, commands with their output, run ids: pointers the judge re-derives on a fresh build of the same workspace (a leaf commits its work to its repo before claiming, so the repo is the primary source).' },
        findings: { type: 'string', description: 'Concerns worth the judge’s eyes when claiming (optional).' },
        reason: { type: 'string', description: 'Required when result is failed: what is blocked, what was tried, and why it is beyond this run’s power.' },
        runs: { type: 'array', items: { type: 'string' }, description: 'Engine run ids that did the work (optional).' },
      },
      required: ['leafId', 'result', 'evidence'],
    },
  },
  {
    name: 'settle_leaf',
    summary: 'The judge’s hand: weigh the claim’s evidence against the leaf’s goal and settle it',
    guidance: 'You weigh the recorded claim — and re-derive what it points at, in your checkout of exactly the claimed commit — against what the leaf’s body says must become true. verdict “verified”: the evidence demonstrates the goal — the leaf is succeeded and verified. verdict “stay-claimed”: plausible but thin — do not mark it done, and do not re-run it; leave it claimed with a note on what is missing: the run parks it for the person, who decides from your note. verdict “failed”: the goal was not reached — a reason is required (what the evidence shows is missing), so the replan can pick an angle. Only a claimed leaf settles: a raw, running, or settled leaf is refused, because settling something unfinished is how claims quietly became verdicts. A claim is a pointer to look at, never the evidence itself.',
    binding: 'platform',
    effect: 'write',
    idempotent: false,
    openWorld: false,
    returns: 'text in the form `settled <leafId> — verified` / `settled <leafId> — failed` / `kept <leafId> claimed — <note>`; the leaf carries the rewrite (status / verified / findings / review note)',
    failures: [
      { when: 'the verdict is missing or out of the three', says: 'what each of the three means, in the leaf’s life' },
      { when: 'the failed settlement has no reason', says: 'what the reason must show' },
      { when: 'the leaf is not claimed with evidence on file', says: 'which state it is in, and that only claims get settled' },
    ],
    parameters: {
      type: 'object',
      properties: {
        leafId: { type: 'string', description: 'The claimed leaf to judge.' },
        verdict: { type: 'string', enum: ['verified', 'stay-claimed', 'failed'], description: 'verified — the evidence demonstrates the goal; stay-claimed — plausible but thin, nothing re-run; failed — the goal was not reached.' },
        note: { type: 'string', description: 'Required when failed (what the evidence shows is missing). For stay-claimed, exactly what you could not establish — the person decides from it. For verified, anything worth the trace.' },
      },
      required: ['leafId', 'verdict'],
    },
  },
  {
    name: 'ready_leaves',
    summary: 'The tree\'s scheduler input: which leaves can be worked now, and what is waiting and why',
    guidance: 'Read-only. Partitions the tree\'s leaves into: ready (pending, dependencies cleared, has open tasks), unbroken (pending but no tasks yet — the plan needs to fill it), blocked (dependencies not succeeded — the ones it waits on), claimed (work claimed, waiting for the judge pass), inFlight (running — should be empty at a fresh pass; treat leftovers as stale), settled (succeeded / failed / cancelled). Returns the partition as JSON; the digest is the count line. Ordering is temporary (creation order); nesting-aware scheduling is not in this v1.',
    binding: 'platform',
    effect: 'read',
    idempotent: true,
    openWorld: false,
    returns: 'A JSON partition { treeId, ready, unbroken, blocked, claimed, awaitingReview, inFlight, settled } and a digest of the form `n ready, n blocked, n without tasks, n in flight, n settled — tree <treeId>`',
    failures: [
      { when: 'treeId is missing or does not exist', says: 'what is required / no such tree' },
    ],
    parameters: {
      type: 'object',
      properties: {
        treeId: { type: 'string', description: 'The tree to compute the ready set for.' },
      },
      required: ['treeId'],
    },
  },
  {
    name: 'next_leaf_task',
    summary: 'The next task of a leaf to work, in dependency order, or whether the leaf is ready to claim, has failed, or has no tasks yet',
    guidance: 'Read-only. Use it to drive a leaf\'s work one task at a time: work the task it hands back, then ask again. A task that failed on its last attempt comes back with what that attempt left as previousAttempt; one that has failed twice fails the leaf.',
    binding: 'platform',
    effect: 'read',
    idempotent: true,
    openWorld: false,
    returns: 'JSON with a step: { step: "run", item } where item is the task to hand to the executor (id, title, doneMeans, leafId, context, and description, role, checks, siblings, previousAttempt when there are any); { step: "claim" } when every task is finished; { step: "fail", reason } when a task failed twice or a task can never start; { step: "unbroken" } when the leaf has no tasks yet',
    failures: [
      { when: 'leafId is missing or is not one of your leaves', says: 'what is required / no such leaf' },
    ],
    parameters: {
      type: 'object',
      properties: {
        leafId: { type: 'string', description: 'The leaf being worked.' },
        siblings: { type: 'string', description: 'A line telling the worker that other leaves are being worked at the same time; passed on in the item.' },
      },
      required: ['leafId'],
    },
  },
];
