import { describe, it, expect } from 'vitest';
import { BUILDER_TOOLS } from '@koala/agent-engine';
import { BUILT_IN_SCENARIOS } from './scenarios.js';
import { scenarioProblems } from './scenario.js';
import { extensionTools, seededPersonas, seededProcedures } from '../../extensions/seeds.js';

describe('the scenarios the platform ships', () => {
  it('are every one valid against the agents, procedures and tools it ships', () => {
    const known = {
      agents: new Set(seededPersonas().map((persona) => persona.slug)),
      procedures: new Set(seededProcedures().map((procedure) => procedure.id)),
      tools: [...extensionTools(), ...BUILDER_TOOLS],
    };
    const refused = BUILT_IN_SCENARIOS.map((scenario) => ({ id: scenario.id, problems: scenarioProblems(scenario, known) })).filter((entry) => entry.problems.length > 0);

    expect(refused).toEqual([]);
  });

  it('have distinct ids', () => {
    const ids = BUILT_IN_SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keep off the bench what holds the model or a cluster for long: the model stories of Odoo, and the monitoring check that deploys a real app', () => {
    expect(BUILT_IN_SCENARIOS.filter((scenario) => scenario.onBench === false).map((scenario) => scenario.id).sort()).toEqual(['mechanics-monitoring', 'story-odoo-client-project', 'story-odoo-field']);
  });
});
