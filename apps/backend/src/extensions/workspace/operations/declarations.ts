import type { HostOperation } from '@koala/agent-engine/procedure';

const NONE = { type: 'object', properties: {} } as const;
const TREE = { name: 'tree', type: 'json', describe: 'The tree, as Read Workspace File hands it on.', required: true } as const;
const PLAN = { name: 'plan', type: 'json', describe: 'The composed workspace, as Compose Workspace hands it on.', required: true } as const;

export const WORKSPACE_OPERATIONS: readonly HostOperation[] = [
  {
    name: 'workspace.read',
    title: 'Read Workspace File',
    group: 'Workspace',
    describe: 'Reads .koala/workspace.json from the tree\'s repository on main: what the project says its workspace needs.',
    inputs: [
      { name: 'treeId', type: 'text', describe: 'Which tree. Nothing wired means the treeId the run was started with.' },
      { name: 'commit', type: 'text', describe: 'The commit on main this build is for. Nothing wired means the commit the run was started with.' },
    ],
    outputs: [
      { name: 'tree', type: 'json', describe: 'The tree: its id, name and project.' },
      { name: 'file', type: 'json', describe: 'What the file says, or nothing when there is no file.' },
      { name: 'commit', type: 'text', describe: 'The commit on main it was read at.' },
      { name: 'reason', type: 'text', describe: 'Why it could not be read or used.' },
    ],
    exits: [
      { name: 'read', describe: 'The file was read, or there is none and the project needs nothing of its own.' },
      { name: 'unreadable', describe: 'There is no such tree, or the file says something the workspace cannot do.' },
    ],
    settings: NONE,
    summary: 'reads what the project says its workspace needs',
    idempotent: true,
  },
  {
    name: 'workspace.compose',
    title: 'Compose Workspace',
    group: 'Workspace',
    describe: 'Puts together everything the tree\'s workspace needs — its type\'s language, the project\'s file, the tools of every agent that works in it — into one image plan, each line saying where it came from, and compares it with the workspace the tree works in now.',
    inputs: [TREE, { name: 'file', type: 'json', describe: 'What the project\'s file says.' }],
    outputs: [
      { name: 'plan', type: 'json', describe: 'The composed workspace: its fingerprint, every line with its source, what it provides and its environment.' },
      { name: 'added', type: 'json', describe: 'The lines the published workspace does not have yet.' },
      { name: 'script', type: 'text', describe: 'An install script the published workspace does not run yet, which a person has to approve.' },
      { name: 'summary', type: 'text', describe: 'What changes, in a line.' },
      { name: 'reason', type: 'text', describe: 'Why it cannot be composed.' },
    ],
    exits: [
      { name: 'changed', describe: 'The workspace needs building: it differs from the one the tree works in.' },
      { name: 'unchanged', describe: 'The tree already works in exactly this workspace.' },
      { name: 'unbuildable', describe: 'What it needs cannot be put together — a binary nothing says how to install, for one.' },
    ],
    settings: NONE,
    summary: 'composes the workspace and compares it with the published one',
    idempotent: true,
  },
  {
    name: 'workspace.build',
    title: 'Build Workspace Image',
    group: 'Workspace',
    describe: 'Builds the composed workspace\'s image in the cluster, waiting for it, or finds it already built.',
    inputs: [PLAN],
    outputs: [
      { name: 'image', type: 'text', describe: 'The image, ready to run.' },
      { name: 'reason', type: 'text', describe: 'Why it did not build, from the build\'s own log.' },
    ],
    exits: [
      { name: 'built', describe: 'The image is built.' },
      { name: 'failed', describe: 'The build failed.' },
    ],
    settings: NONE,
    summary: 'builds the workspace image',
    idempotent: true,
  },
  {
    name: 'workspace.publish',
    title: 'Publish Workspace',
    group: 'Workspace',
    describe: 'Makes the built image the tree\'s workspace. Every run of the tree works in it from now on, and one already working is moved onto it at its next command, its files kept.',
    inputs: [
      TREE,
      PLAN,
      { name: 'file', type: 'json', describe: 'What the project\'s file said, kept so later runs compose from the same version until the next build.' },
      { name: 'image', type: 'text', describe: 'The built image.', required: true },
      { name: 'commit', type: 'text', describe: 'The commit on main it was built from.' },
    ],
    outputs: [{ name: 'published', type: 'json', describe: 'The workspace as published.' }],
    exits: [{ name: 'published', describe: 'The tree works in it now.' }],
    settings: NONE,
    summary: 'makes it the tree\'s workspace',
    idempotent: true,
  },
  {
    name: 'workspace.resume',
    title: 'Resume Waiting Stories',
    group: 'Workspace',
    describe: 'Puts back in line every story of the tree that was put aside waiting for its workspace, its waiting tasks ready to be worked again, and starts the tree growing so they are taken up.',
    inputs: [TREE],
    outputs: [{ name: 'resumed', type: 'json', describe: 'The titles of the stories put back in line.' }],
    exits: [
      { name: 'resumed', describe: 'Stories were waiting, and the tree is growing again.' },
      { name: 'none', describe: 'No story was waiting.' },
    ],
    settings: NONE,
    summary: 'puts the stories that waited for it back in line',
    idempotent: true,
  },
  {
    name: 'workspace.notify',
    title: 'Tell the Project',
    group: 'Workspace',
    describe: 'Posts what happened to the workspace in the project\'s channel: that it is ready and what it added, that a build waits for the person, or why it failed.',
    inputs: [
      { name: 'tree', type: 'json', describe: 'The tree, as Read Workspace File hands it on. Nothing is posted without one: there is no project to tell.' },
      { name: 'summary', type: 'text', describe: 'What changed, when it is ready or waiting.' },
      { name: 'reason', type: 'text', describe: 'Why, when it failed.' },
    ],
    outputs: [],
    exits: [{ name: 'told', describe: 'The notice is posted.' }],
    settings: {
      type: 'object',
      required: ['what'],
      properties: { what: { type: 'string', title: 'What to say', enum: ['ready', 'waiting', 'failed', 'declined'] } },
    },
    summary: 'tells the project\'s channel',
    idempotent: true,
  },
];
