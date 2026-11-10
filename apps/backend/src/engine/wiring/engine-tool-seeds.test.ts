import { describe, it, expect } from 'vitest';
import { checkDefinition } from '@koala/agent-engine';
import { ENGINE_TOOL_SEEDS, seedEngineTools } from './engine-tool-seeds.js';

describe('the tools the platform seeds', () => {
  it('are every one a declaration startup accepts, so a bad one fails here rather than stopping the server', () => {
    const refused = ENGINE_TOOL_SEEDS
      .map((tool) => ({ name: tool.name, problems: checkDefinition(tool).map((problem) => problem.message) }))
      .filter((tool) => tool.problems.length > 0);

    expect(refused).toEqual([]);
  });
});

describe('a store that cannot be read', () => {
  it('stops the seeding with why, saving nothing, rather than taking it as nothing stored', async () => {
    let saved = 0;
    await expect(seedEngineTools({ getEngineTools: async () => { throw new Error('mongo is not answering'); }, saveEngineTool: async () => { saved += 1; } } as unknown as Parameters<typeof seedEngineTools>[0])).rejects.toThrow('mongo is not answering');
    expect(saved).toBe(0);
  });
});
