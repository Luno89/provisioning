import { describe, expect, it } from 'vitest';
import { LANGUAGE_IDS } from '@koala/agent-engine';
import { CHANGE_WORKSPACE, WORKSPACE_TOOLS } from './catalogue.js';

describe('change_workspace', () => {
  const properties = (WORKSPACE_TOOLS.find((tool) => tool.name === CHANGE_WORKSPACE)!.parameters as { properties: Record<string, { description?: string }> }).properties;

  it('offers exactly the languages a workspace can be built with', () => {
    expect(properties.languages!.description).toBe(`Languages the workspace should have: ${LANGUAGE_IDS.join(', ')}.`);
  });

  it('offers dependencies by name, koala-e2e among them', () => {
    expect(properties.needs!.description).toMatch(/koala-e2e/);
  });
});
