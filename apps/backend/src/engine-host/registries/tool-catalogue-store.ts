import { withBuiltIns } from '../../lib/ownership.js';
import { BUILDER_TOOLS, type ToolDefinition, type ToolStatus } from '@koala/agent-engine';

export interface ToolReader {
  list(ownerId?: string): Promise<ToolDefinition[]>;
}

export interface StoredToolCatalogueOptions {
  tools: ToolReader;
  bootstrap?: readonly ToolDefinition[] | undefined;
  include?: ToolStatus[] | undefined;
}

export interface StoredToolCatalogue {
  list(ownerId: string): Promise<ToolDefinition[]>;
  names(ownerId: string): Promise<string[]>;
}

export function createStoredToolCatalogue(
  options: StoredToolCatalogueOptions,
): StoredToolCatalogue {
  const bootstrap = options.bootstrap ?? BUILDER_TOOLS;
  const include = options.include ?? ['approved'];

  const list = async (ownerId: string): Promise<ToolDefinition[]> => {
    const stored = await options.tools.list(ownerId);
    const owned = withBuiltIns(stored, ownerId, (tool) => tool.name);

    return [...bootstrap, ...owned.filter((tool) => include.includes(tool.status))];
  };

  return {
    list,
    async names(ownerId) {
      return (await list(ownerId)).map((tool) => tool.name).sort();
    },
  };
}
