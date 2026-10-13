import type { ToolDefinition } from '@koala/agent-engine';

const NAMES = { type: 'array', items: { type: 'string' } } as const;

export const CHANGE_WORKSPACE = 'change_workspace';
export const MARK_WAITING = 'mark_waiting';

export const WORKSPACE_TOOLS: ToolDefinition[] = [
  {
    name: CHANGE_WORKSPACE,
    summary: 'Add a system package, a language, an environment value or an install script to the tree\'s workspace, for every run of the tree from now on',
    guidance: 'For something the work needs that the workspace does not have — a binary a command could not find, a library a build needs. '
      + 'Installing it yourself with dnf or pip in the workspace does not last: the next workspace is built from its image, so ask here instead. '
      + 'It is committed to .koala/workspace.json on main and the workspace is rebuilt; it is not there until the rebuild is published, which takes minutes, and longer when it carries a new install script, which waits for the person to approve it. '
      + 'Your run moves onto the new workspace at its next command after that, its files kept. Carry on with what does not need it. '
      + 'Never put a secret in env: a model works in this workspace.',
    binding: 'platform',
    effect: 'write',
    idempotent: true,
    openWorld: false,
    destructive: false,
    returns: 'What was added and that the workspace is being rebuilt, or that it has everything asked for already',
    failures: [
      { when: 'the run is not in a tree and names none', says: 'that it needs a treeId' },
      { when: 'something asked for cannot go in the file — a secret-like env name, an unknown language or package manager', says: 'what to fix, and that nothing was committed' },
      { when: 'the file changed on main while it was being written', says: 'to call it again' },
    ],
    parameters: {
      type: 'object',
      properties: {
        why: { type: 'string', description: 'What needs it — the command that failed, the feature that uses it. It goes in the commit message the person reads.' },
        dnf: { ...NAMES, description: 'System packages, by their Fedora/RHEL names; apt names are used when the image is Debian-based.' },
        apt: { ...NAMES, description: 'System packages, by their Debian names, for a Debian-based image only.' },
        pip: { ...NAMES, description: 'Python packages.' },
        npm: { ...NAMES, description: 'Node packages, installed globally.' },
        languages: { ...NAMES, description: 'Languages the workspace should have: python, node, go, java, rust.' },
        env: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'] }, description: 'Plain environment values, never a credential.' },
        script: { type: 'string', description: 'Shell commands to run at the end of the image build, for what no package manager has. The person approves it before it runs.' },
        treeId: { type: 'string', description: 'The tree. Leave out when working in one, or in a chat about one.' },
      },
      required: ['why'],
    },
  },
  {
    name: MARK_WAITING,
    summary: 'Say a task cannot go on until the workspace has what was asked for with change_workspace',
    guidance: 'Only once change_workspace has committed what the task needs, and only when nothing else in the task can be done without it. '
      + 'The task waits, neither done nor failed; when every task left in the story waits, the story is put aside — not failed, not replanned — and put back in line when the rebuilt workspace is published. '
      + 'Then end your turn: say what you did and what is left for when it is there.',
    binding: 'platform',
    effect: 'write',
    idempotent: true,
    openWorld: false,
    destructive: false,
    returns: 'Confirmation naming the task and what the workspace is still to get',
    failures: [
      { when: 'the workspace already has everything its file asks for', says: 'that there is nothing to wait for: what was just asked for is already built, so run the command again; otherwise ask with change_workspace, or the command needs something else' },
      { when: 'no task has that id, or it is finished', says: 'which' },
    ],
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task that waits.' },
        waitsFor: { type: 'string', description: 'What it waits for and what it will do with it, for whoever takes it up again.' },
        treeId: { type: 'string', description: 'The tree. Leave out when working in one.' },
      },
      required: ['taskId', 'waitsFor'],
    },
  },
];
