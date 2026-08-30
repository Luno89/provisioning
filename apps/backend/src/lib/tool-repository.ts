import { ALL_TOOL_SEEDS, type ToolRepositoryItem } from './tool-seeds.js';

export type { ToolRepositoryItem };
export const TOOL_REPOSITORY: ToolRepositoryItem[] = ALL_TOOL_SEEDS;

export function formatToolRepoForOpenAI(items: ToolRepositoryItem[] = TOOL_REPOSITORY) {
  return items.map((item) => ({
    type: 'function' as const,
    function: {
      name: item.name,
      description: item.description,
      parameters: item.parameters,
    },
  }));
}
