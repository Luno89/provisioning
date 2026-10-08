import { withBuiltIns } from '../../lib/ownership.js';
import { BUILDER_TOOLS, type ToolDefinition } from '@koala/agent-engine';

export interface ToolReader {
  list(ownerId?: string): Promise<ToolDefinition[]>;
}

export interface StoredToolCatalogueOptions {
  tools: ToolReader;
  bootstrap?: readonly ToolDefinition[] | undefined;
}

export interface StoredToolCatalogue {
  list(ownerId: string): Promise<ToolDefinition[]>;
  names(ownerId: string): Promise<string[]>;
}

export function createStoredToolCatalogue(
  options: StoredToolCatalogueOptions,
): StoredToolCatalogue {
  const bootstrap = options.bootstrap ?? BUILDER_TOOLS;

  const list = async (ownerId: string): Promise<ToolDefinition[]> => {
    const stored = withBuiltIns(await options.tools.list(ownerId), ownerId, (tool) => tool.name);
    const storedNames = new Set(stored.map((tool) => tool.name));

    // One catalogue. What is stored is what runs, and a persona granting it is the whole gate.
    return [...bootstrap.filter((tool) => !storedNames.has(tool.name)), ...stored];
  };

  return {
    list,
    async names(ownerId) {
      return (await list(ownerId)).map((tool) => tool.name).sort();
    },
  };
}
