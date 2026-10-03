import type { EngineExtension } from '@koala/agent-engine/procedure';
import { GROVE_OPERATIONS } from './operations/declarations.js';
import { GROVE_TOOLS } from './tools/grove-tools-catalogue.js';
import { GROVE_PERSONAS } from './personas.js';
import { GROVE_LEAF, GROVE_PAPER_LEAF, GROVE_PAPER_RUN, GROVE_RUN } from './procedures.js';

export const GROVE: EngineExtension = {
  id: 'grove',
  title: 'Grove',
  describe: 'Trees of work: a goal planned into branches and leaves, each leaf worked in its own worktree of one shared workspace, claimed, checked and judged, and replanned when it fails.',
  version: '1',
  requires: ['platform'],
  operations: GROVE_OPERATIONS,
  tools: GROVE_TOOLS,
  personas: GROVE_PERSONAS,
  procedures: [GROVE_LEAF, GROVE_PAPER_LEAF, GROVE_RUN, GROVE_PAPER_RUN],
};
