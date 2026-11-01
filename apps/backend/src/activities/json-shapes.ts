export const recordOf = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});

export const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value as unknown[] : []);

export const hasReadyNode = (nodes: unknown): boolean => listOf(recordOf(nodes).items)
  .some((node) => listOf(recordOf(recordOf(node).status).conditions)
    .some((condition) => recordOf(condition).type === 'Ready' && recordOf(condition).status === 'True'));
