import type { GrantMap } from '@koala/agent-engine';
import { CHANGE_WORKSPACE, MARK_WAITING } from './tools/catalogue.js';
import type { PersonaRecord } from '@koala/agent-engine';

export const WORKSPACE_AGENT = 'workspace';

export const WORKSPACE_PERSONAS: PersonaRecord[] = [
  {
    slug: WORKSPACE_AGENT,
    name: 'Workspace',
    description: 'Builds a tree\'s workspace from what its project declares, and makes the tree work in it',
    version: '1',
    guidance: 'Started when a project\'s .koala/workspace.json changes on main. It runs no model of its own: its procedure reads the file, composes and builds the image, and publishes it.',
    returns: 'The workspace as published, or why it was not changed.',
    failures: [
      { when: 'the file says something a workspace cannot do', says: 'what is wrong with it' },
      { when: 'the image does not build', says: 'why, from the build\'s log, and the tree keeps the workspace it had' },
      { when: 'the person declines an install script', says: 'that the workspace was not changed' },
    ],
    procedure: 'build-workspace',
    maxEffect: 'write',
    environment: {},
    interface: {
      inputs: {
        type: 'object',
        properties: {
          treeId: { type: 'string', description: 'The tree whose workspace to build.' },
          commit: { type: 'string', description: 'The commit on main the file was read at.' },
        },
        required: ['treeId'],
      },
      outputs: ['result'],
    },
    prompt: 'You are the structure of a workspace build, not a thinker in it. The procedure decides every step.',
  },
];

export const WORKSPACE_GRANTS: GrantMap = {
  executor: [CHANGE_WORKSPACE, MARK_WAITING],
  planner: [CHANGE_WORKSPACE],
  koala: [CHANGE_WORKSPACE],
};
