import { listAt, recordAt } from '../platform/index.js';

export const hasReadyNode = (nodes: unknown): boolean => listAt(nodes, 'items')
  .some((node) => listAt(node, 'status', 'conditions')
    .some((condition) => recordAt(condition).type === 'Ready' && recordAt(condition).status === 'True'));
