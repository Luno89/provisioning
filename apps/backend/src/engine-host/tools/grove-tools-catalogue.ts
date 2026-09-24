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
    name: 'list_tree_types',
    summary: 'List the kinds of project a new tree can be, with what each is for',
    guidance: 'Check this before proposing a new tree: the tree type decides how the project is built and judged, and only these ids are accepted.',
    binding: 'platform',
    effect: 'read',
    status: 'draft',
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
    status: 'draft',
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
          description: 'A new tree, when there is no treeId: { name, type, goal } — type is one of the person\'s tree types.',
        },
        planDoc: { type: 'string', description: 'Markdown for PLAN.md: the goal, the approach, the assumptions you made, the questions still open.' },
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
    name: 'make_branch',
    summary: 'Branch a tree in a direction',
    guidance: 'Creates a real branch under the named tree and returns its id. Use it to set a plan direction before growing leaves under it — a leaf always lives under a branch.',
    binding: 'platform',
    effect: 'write',
    status: 'draft',
    returns: 'text in the form `branched <id> — "<title>" under <treeId>`',
    failures: [
      { when: 'the tree does not exist', says: 'no such tree, with the id it was given' },
      { when: 'no title', says: 'what a title is for, plainly' },
    ],
    parameters: {
      type: 'object',
      properties: {
        treeId: { type: 'string', description: 'The tree the direction belongs to.' },
        title: { type: 'string', description: 'The direction itself in one line.' },
      },
      required: ['treeId', 'title'],
    },
  },
  {
    name: 'make_leaf',
    summary: 'Grow a leaf under a branch: one unit of the plan with a checkable goal',
    guidance: 'Creates a real leaf under the named branch and returns its id. The body is not decoration — it is the statement a later judge checks when deciding whether the leaf has been reached, so write it as a concrete end state, not a verb phrase. Leaves may wait on other leaves through dependsOn.',
    binding: 'platform',
    effect: 'write',
    status: 'draft',
    returns: 'text in the form `grown <id> — "<title>" under <branchId>`',
    failures: [
      { when: 'the branch does not exist', says: 'no such branch — make it with make_branch first' },
      { when: 'the body is blank', says: 'that the body is what gets judged, and to make it checkable' },
      { when: 'a leaf dependency does not exist', says: 'which ids were not found' },
    ],
    parameters: {
      type: 'object',
      properties: {
        branchId: { type: 'string', description: 'The branch the leaf belongs to.' },
        title: { type: 'string', description: 'The leaf in a few words.' },
        body: { type: 'string', description: 'What the leaf is for — the concrete end state, in one or two sentences, that a later judge can check.' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'Ids of other leaves this one should not start before.' },
      },
      required: ['branchId', 'title', 'body'],
    },
  },
  {
    name: 'claim_leaf',
    summary: 'The executor’s hand: file the claim on a worked leaf — evidence for the judge, or a failed claim with the reason',
    guidance: 'Work has a terminal word, and it is not your verdict. result “claimed”: the leaf’s tasks are done and here is the evidence — write it as pointers the judge can re-derive, not prose (commands with their output, file paths, run ids); findings flags concerns for the judge. result “failed”: the work is blocked beyond your power — a reason is required (what is blocked, what you tried, why it is beyond you). A claim moves the leaf to claimed/failed and never past that: the judge, in the judge pass, weighs the evidence against the leaf’s goal and settles it. A proposed (unaccepted) leaf, an already-claimed leaf, and a settled leaf are all refused — each with the state it is in and what comes next.',
    binding: 'platform',
    effect: 'write',
    status: 'draft',
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
    guidance: 'You weigh the recorded claim — and re-derive what it points at, in your own fresh workspace built from the same commit — against what the leaf’s body says must become true. verdict “verified”: the evidence demonstrates the goal — the leaf is succeeded and verified. verdict “stay-claimed”: plausible but thin — do not mark it done, and do not re-run it; leave it claimed with a note on what is missing, so a later judge or a person can promote it. verdict “failed”: the goal was not reached — a reason is required (what the evidence shows is missing), so the replan can pick an angle. Only a claimed leaf settles: a raw, running, or settled leaf is refused, because settling something unfinished is how claims quietly became verdicts. A claim is a pointer to look at, never the evidence itself.',
    binding: 'platform',
    effect: 'write',
    status: 'draft',
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
        note: { type: 'string', description: 'Required when failed (what the evidence shows is missing). For stay-claimed, what is thin, so a later judge or person can promote it. For verified, anything worth the trace.' },
      },
      required: ['leafId', 'verdict'],
    },
  },
  {
    name: 'ready_leaves',
    summary: 'The tree\'s scheduler input: which leaves can be worked now, and what is waiting and why',
    guidance: 'Read-only. Partitions the tree\'s leaves into: ready (pending, dependencies cleared, has open tasks), unbroken (pending but no tasks yet — the plan needs to fill it), blocked (dependencies not succeeded — the ones it waits on), notApproved (proposed — waiting for acceptance), claimed (work claimed, waiting for the judge pass), inFlight (running — should be empty at a fresh pass; treat leftovers as stale), settled (succeeded / failed / cancelled). Returns the partition as JSON; the digest is the count line. Ordering is temporary (creation order); nesting-aware scheduling is not in this v1.',
    binding: 'platform',
    effect: 'read',
    status: 'draft',
    returns: 'A JSON partition { treeId, ready, unbroken, blocked, notApproved, inFlight, settled } and a digest of the form `n ready, n blocked, n without tasks, n in flight, n settled — tree <treeId>`',
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
];