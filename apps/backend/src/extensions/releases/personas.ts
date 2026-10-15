import type { PersonaRecord } from '@koala/agent-engine';
import { RELEASE_AGENT, RELEASE_PROCEDURE, ROLL_BACK_AGENT, ROLL_BACK_PROCEDURE } from '../../lib/release-run.js';

const RELEASE_PLACE = {
  ownerId: { type: 'string', description: 'Whose project it is.' },
  projectId: { type: 'string', description: 'The project being released.' },
  adapter: { type: 'string', description: 'Which app the release adapter knows it as (odoo).' },
  target: { type: 'object', description: 'The cluster, namespace and release name it goes into.' },
  host: { type: 'string', description: 'The address the live app answers on.' },
  previewHost: { type: 'string', description: 'The address a preview answers on.' },
  secretTarget: { type: 'object', description: 'Where the project\'s vault syncs its secrets to.' },
} as const;

const BUILD = { type: 'object', description: 'A build: its release id, image, source commit and vault.' } as const;

const RELEASE_INPUTS = {
  type: 'object',
  properties: { ...RELEASE_PLACE, build: BUILD },
  required: ['ownerId', 'projectId', 'adapter', 'target', 'host', 'previewHost', 'secretTarget', 'build'],
} as const;

const ROLL_BACK_INPUTS = {
  type: 'object',
  properties: { ...RELEASE_PLACE, from: { type: 'string', description: 'The live release to go back from.' }, to: BUILD },
  required: ['ownerId', 'projectId', 'adapter', 'target', 'host', 'previewHost', 'secretTarget', 'from', 'to'],
} as const;

export const RELEASE_PERSONAS: PersonaRecord[] = [
  {
    slug: RELEASE_AGENT,
    name: 'Release',
    description: 'Releases a project\'s build the way its tree type says: beside the live slot, with a preview the person cuts over or discards',
    version: '1',
    guidance: 'Started by the platform when a project\'s build is ready to release. It runs no model: its procedure prepares the build, runs its browser tests and waits for the person\'s decision on the release card.',
    returns: 'How the release ended: live, discarded, set aside for a newer build, or failed with why.',
    failures: [
      { when: 'preparing or cutting over breaks', says: 'what broke; the live slot keeps serving' },
      { when: 'a newer build arrives while it waits', says: 'that it was set aside' },
    ],
    procedure: RELEASE_PROCEDURE,
    maxEffect: 'write',
    environment: {},
    interface: { inputs: RELEASE_INPUTS, outputs: ['result'] },
    prompt: 'You are the structure of a release, not a thinker in it. The procedure decides every step.',
  },
  {
    slug: ROLL_BACK_AGENT,
    name: 'Release roll back',
    description: 'Goes back to the release kept at a project\'s last cut-over',
    version: '1',
    guidance: 'Started by the platform when the person rolls a live release back. It runs no model.',
    returns: 'Whether the kept release is live again, or why not.',
    failures: [{ when: 'the kept slot no longer holds that release, or will not start', says: 'which; the current release keeps serving' }],
    procedure: ROLL_BACK_PROCEDURE,
    maxEffect: 'write',
    environment: {},
    interface: { inputs: ROLL_BACK_INPUTS, outputs: ['result'] },
    prompt: 'You are the structure of a roll back, not a thinker in it. The procedure decides every step.',
  },
];
