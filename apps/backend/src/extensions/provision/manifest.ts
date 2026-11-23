import type { EngineExtension } from '@koala/agent-engine/procedure';
import { PROVISION_OPERATIONS } from './operations/declarations.js';
import { PROVISION_PERSONAS } from './personas.js';
import { PROVISION } from './procedures.js';

export const PROVISION_EXTENSION: EngineExtension = {
  id: 'provision',
  title: 'Provision',
  describe: 'How a Koala sets itself up after its chart: its platform services and monitoring on its own cluster, and the collector on each other machine of the person\'s, every piece at once, each shown with what it waits on and why it failed.',
  version: '1',
  requires: ['platform'],
  operations: [...PROVISION_OPERATIONS],
  tools: [],
  personas: PROVISION_PERSONAS,
  grants: {},
  procedures: [PROVISION],
};
