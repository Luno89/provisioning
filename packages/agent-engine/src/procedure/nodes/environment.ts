import { defineNode } from '../definition.js';
import type { BuiltInNode } from '../implementation.js';
import { NO_SETTINGS } from '../settings-schema.js';

export const provisionSandbox: BuiltInNode = {
  definition: defineNode({
    kind: 'provision-sandbox',
    title: 'Provision Sandbox',
    category: 'environment',
    describe: 'Gets the run somewhere to work, derived from the tools its persona is granted: nothing, a fresh sandbox pod built from a matching image, or a registered machine. Pair it with Release Sandbox in the cleanup lane.',
    role: 'step',
    inputs: [],
    outputs: [
      { name: 'environment', type: 'environment', describe: 'Where the run is working.' },
      { name: 'reason', type: 'text', describe: 'Why no environment could be provided, when none could.' },
    ],
    exits: [
      { name: 'ready', describe: 'The environment is ready.' },
      { name: 'unavailable', describe: 'No suitable environment could be provided, and the output says why.' },
    ],
    settings: NO_SETTINGS,
    runs: 'activity',
    idempotent: true,
    summarize: () => 'gets the run somewhere to work',
  }),
};

export const releaseSandbox: BuiltInNode = {
  definition: defineNode({
    kind: 'release-sandbox',
    title: 'Release Sandbox',
    category: 'environment',
    describe: 'Releases the run\'s sandbox so it stops using the cluster. Safe to run when there is none, and safe to run twice.',
    role: 'step',
    inputs: [{ name: 'environment', type: 'environment', describe: 'The environment to release.' }],
    outputs: [],
    exits: [{ name: 'done', describe: 'Released, or there was nothing to release.' }],
    settings: NO_SETTINGS,
    runs: 'activity',
    idempotent: true,
    summarize: () => 'releases the sandbox',
  }),
};

export const ENVIRONMENT_NODES = [provisionSandbox, releaseSandbox];
