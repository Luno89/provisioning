import type { ToolDefinition } from '@koala/agent-engine';

export const TASK_TOOLS: ToolDefinition[] = [
  {
    name: 'propose_work',
    summary: 'Propose one unit of work for a person to accept',
    guidance: 'Use this once for each piece of work a goal breaks into. Each proposal should be small '
      + 'enough to finish in one sitting and say what "done" means precisely enough that someone else '
      + 'can check it. Proposed work does nothing until a person accepts it. Give dependsOn the ids of '
      + 'proposals that must finish first, using the ids earlier calls returned. '
      + 'When you are breaking down a Grove leaf (give leafId), the proposal is one task under that leaf: '
      + 'it also needs a full description — what will actually be done, end to end — and its role, the part '
      + 'it plays in the overall project. A leaf may keep zero tasks (planned, not broken down), and a leaf '
      + 'task may wait only on tasks of the same leaf.',
    binding: 'platform',
    effect: 'write',
    status: 'draft',
    returns: 'The new task\'s id and status, so later proposals can depend on it.',
    failures: [
      { when: 'the title or doneMeans is missing', says: 'a task needs a title / a task needs to say what "done" means' },
      { when: 'a leaf task is missing description or role', says: 'exactly which is missing, and what it is for' },
      { when: 'a dependency does not exist', says: 'these dependencies do not exist: <ids>' },
      { when: 'a leaf task waits on work outside its leaf', says: 'work under a leaf can only wait on the same leaf' },
      { when: 'the dependencies would form a loop', says: 'that would make work wait on itself: <ids>' },
      { when: 'the run has no owner', says: 'this run has no owner to propose work for' },
    ],
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What the work is, in a few words' },
        doneMeans: { type: 'string', description: 'What will be true once it is finished, precisely enough to check' },
        leafId: { type: 'string', description: 'The Grove leaf this task works under, when planning one. Sets the description and role requirements.' },
        intent: { type: 'string', description: 'Why the work is needed' },
        description: { type: 'string', description: 'What will actually be done, end to end. Required when leafId is set.' },
        role: { type: 'string', description: 'The part the task plays in the overall project. Required when leafId is set.' },
        agent: { type: 'string', description: 'Which persona should do it, if not the executor' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'Ids of proposals that must be done first' },
        checks: {
          type: 'object',
          description: 'How to check the work: { "command": a shell command that shows it is done, "expects": text its output should contain }',
        },
      },
      required: ['title', 'doneMeans'],
    },
  },
  {
    name: 'list_tasks',
    summary: 'List the work that exists and what state each piece is in',
    guidance: 'Use this to see what work there is, or with ready true to see only what can be '
      + 'started now — work that is accepted and whose dependencies are all finished. Asking for '
      + 'ready work is not the same as asking for accepted work: an accepted task still waiting on '
      + 'another is not ready.',
    binding: 'platform',
    effect: 'read',
    status: 'draft',
    replaces: ['list_leaves', 'get_leaf'],
    returns: 'One line per task — its id, title and state — and the same set as JSON carrying id, '
      + 'title, status, what done means, what it depends on and which persona it is for. An empty '
      + 'result says so in words rather than returning nothing.',
    failures: [
      { when: 'the run has no owner', says: 'this run has no owner whose work it could list' },
      { when: 'nothing is ready to start', says: 'nothing is ready to start' },
      { when: 'a status filter matches nothing', says: 'no <status> work' },
    ],
    parameters: {
      type: 'object',
      properties: {
        ready: {
          type: 'boolean',
          description: 'True to list only work that can be started now — accepted, with every dependency finished',
        },
        status: {
          type: 'string',
          description: 'List only work in this state',
          enum: ['proposed', 'accepted', 'running', 'done', 'failed', 'dropped'],
        },
      },
    },
  },
  {
    name: 'start_task',
    summary: 'Claim a task for this run and mark it running',
    guidance: 'Use this when you are about to do a piece of work, so nobody else picks it up and '
      + 'the run that did it is recorded. Claiming a task does not check that it is ready — list '
      + 'with ready true first if you are choosing what to work on rather than being handed it.',
    binding: 'platform',
    effect: 'write',
    status: 'draft',
    returns: 'Confirmation naming the task, and the list of runs that have claimed it, so a second '
      + 'claim is visible rather than silent.',
    failures: [
      { when: 'no task has that id', says: 'there is no task called "<taskId>"' },
      { when: 'the taskId argument is missing', says: 'this call needs a "taskId"' },
      { when: 'the run has no owner', says: 'this run has no owner' },
    ],
    parameters: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The id of the task to claim, as given by list_tasks',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'mark_done',
    summary: 'Record a task finished, with evidence, and learn what it unblocked',
    guidance: 'Use this once the work is actually finished and what "done" means for the task has '
      + 'been met. Say what shows it — the evidence is what a judge reads later. If the work did '
      + 'not succeed this is the wrong tool and marking it done anyway hides the failure.',
    binding: 'platform',
    effect: 'write',
    status: 'draft',
    returns: 'Confirmation naming the task, then what it unblocked — tasks that depended on it and '
      + 'now have nothing else outstanding — or that nothing was waiting on it.',
    failures: [
      { when: 'no task has that id', says: 'there is no task called "<taskId>"' },
      { when: 'the taskId argument is missing', says: 'this call needs a "taskId"' },
      { when: 'the run has no owner', says: 'this run has no owner' },
    ],
    parameters: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The id of the task that is finished',
        },
        evidence: {
          type: 'string',
          description: 'What shows the work is done — the output, the passing check, the file that now exists',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'mark_failed',
    summary: 'Record that a task was attempted and did not succeed, and why',
    guidance: 'Use this when the work was tried and did not meet what "done" means for the task. '
      + 'Say what went wrong; the reason is what whoever picks it up next reads first.',
    binding: 'platform',
    effect: 'write',
    status: 'draft',
    returns: 'Confirmation naming the task and its new status.',
    failures: [
      { when: 'no task has that id', says: 'there is no task called "<taskId>"' },
      { when: 'the taskId argument is missing', says: 'this call needs a "taskId"' },
      { when: 'the run has no owner', says: 'this run has no owner' },
    ],
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The id of the task that did not succeed' },
        reason: { type: 'string', description: 'What went wrong' },
      },
      required: ['taskId'],
    },
  },
];
