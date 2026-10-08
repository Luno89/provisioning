import { describe, it, expect } from 'vitest';
import { checkDefinition } from '@koala/agent-engine';
import { ENGINE_TOOL_SEEDS } from './engine-tool-seeds.js';

describe('the tools the platform seeds', () => {
  it('are every one a declaration startup accepts, so a bad one fails here rather than stopping the server', () => {
    const refused = ENGINE_TOOL_SEEDS
      .map((tool) => ({ name: tool.name, problems: checkDefinition(tool).map((problem) => problem.message) }))
      .filter((tool) => tool.problems.length > 0);

    expect(refused).toEqual([]);
  });
});
