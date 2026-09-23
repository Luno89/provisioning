import type { ToolDefinition } from '@koala/agent-engine';

/**
 * Engine tools for shaping a Grove tree: branches and leaves. Tasks under a leaf belong to
 * propose_work; this catalogue is the other half of the planner's hands.
 */
export const GROVE_TOOLS: ToolDefinition[] = [
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
    name: 'ready_leaves',
    summary: 'The tree\'s scheduler input: which leaves can be worked now, and what is waiting and why',
    guidance: 'Read-only. Partitions the tree\'s leaves into: ready (pend, dependencies cleared, has open tasks), unbroken (pending but no tasks yet — the plan needs to fill it), blocked (dependencies not succeeded — the ones it waits on), notApproved (proposed — waiting for acceptance), inFlight (running — should be empty at a fresh pass; treat leftovers as stale), settled (succeeded / failed / cancelled). Returns the partition as JSON; the digest is the count line. Ordering is temporary (creation order); nesting-aware scheduling is not in this v1.',
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