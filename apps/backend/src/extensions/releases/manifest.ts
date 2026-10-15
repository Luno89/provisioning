import type { EngineExtension } from '@koala/agent-engine/procedure';
import { RELEASE_OPERATIONS } from './operations/declarations.js';
import { RELEASE_PERSONAS } from './personas.js';
import { REPLACE, SLOTS, SLOTS_ROLL_BACK } from './procedures.js';
import { PROPOSE_RELEASE_CHANGE, RELEASE_TOOLS } from './tools/catalogue.js';

export const RELEASES: EngineExtension = {
  id: 'releases',
  title: 'Releases',
  describe: 'How a project\'s builds become its running app: released beside the live slot with a preview the person cuts over or discards, and rolled back to the slot kept at the last cut-over. The app\'s own steps come from its adapter.',
  version: '1',
  requires: ['platform'],
  operations: [...RELEASE_OPERATIONS],
  tools: RELEASE_TOOLS,
  personas: RELEASE_PERSONAS,
  grants: { koala: [PROPOSE_RELEASE_CHANGE] },
  procedures: [SLOTS, SLOTS_ROLL_BACK, REPLACE],
};
