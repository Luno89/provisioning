import { WORKSPACE_IMAGES, type WorkspaceLanguage } from './workspace-spec.js';
import { ALL_TOOL_SEEDS, type ToolRepositoryItem } from './tool-seeds.js';

export type { ToolRepositoryItem };
export const TOOL_REPOSITORY: ToolRepositoryItem[] = ALL_TOOL_SEEDS;

export function getToolRepository(category?: string): ToolRepositoryItem[] {
  if (!category) return TOOL_REPOSITORY;
  return TOOL_REPOSITORY.filter((t) => t.category === category);
}

export function findToolById(id: string): ToolRepositoryItem | undefined {
  return TOOL_REPOSITORY.find((t) => t.id === id || t.name === id);
}

export function validateImageForTools(language: WorkspaceLanguage, toolIds: string[]): { valid: boolean; missingBinaries: string[] } {
  const spec = WORKSPACE_IMAGES[language];
  if (!spec) return { valid: false, missingBinaries: ['unknown_language'] };
  
  const required = new Set<string>();
  for (const id of toolIds) {
    const item = findToolById(id);
    if (item) {
      item.requiresBinaries.forEach((b) => required.add(b));
    }
  }
  
  const missing = Array.from(required).filter((b) => spec.absent.includes(b));
  return { valid: missing.length === 0, missingBinaries: missing };
}

export function formatToolRepoForOpenAI(items: ToolRepositoryItem[] = TOOL_REPOSITORY) {
  return items.map((item) => ({
    type: 'function',
    function: {
      name: item.name,
      description: item.description,
      parameters: item.parameters,
    },
  }));
}
