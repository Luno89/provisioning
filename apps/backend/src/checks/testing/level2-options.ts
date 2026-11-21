import { BUILDER_TOOLS } from '@koala/agent-engine';
import { ENGINE_TOOL_SEEDS } from '../../engine-host/tools/engine-tool-seeds.js';
import { seededPersonas } from '../../extensions/seeds.js';
import { grantsActingAsOwner } from '../../engine/testing/run-grants.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { Scenario } from '../../eval/level2/scenario.js';
import type { ScenarioResult } from '../../eval/level2/results.js';
import type { CheckRunner, Level2ServiceOptions } from '../services/Level2Service.js';

export const BUILDER_SAVES: Scenario = {
  id: 'builder-saves',
  name: 'The builder checks then saves',
  describe: 'It should compile before writing.',
  agent: 'agent-builder',
  procedure: { id: 'tool-rounds' },
  input: { message: 'Save this as tidy once it checks out.' },
  expect: { outcome: 'ok', toolsInOrder: ['check_procedure', 'save_procedure'], toolsNotCalled: ['list_tasks'] },
};

export const scenarioResult = (scenarioId: string, passed: boolean): ScenarioResult => ({
  scenarioId, name: scenarioId, runId: `run-of-${scenarioId}`, procedure: { id: 'tool-rounds', version: '3' }, passed, outcome: passed ? 'ok' : 'failed',
  answer: '', checks: [{ what: 'finishes ok', passed, detail: passed ? 'it finished ok' : 'it finished failed' }], calls: [], counters: { rounds: 1, toolCalls: 1, totalTokens: 10 }, tasks: [], durationMs: 5,
});

export function level2Options(db: Pick<Database, 'checks' | 'engine'>, checks: CheckRunner, builtIn: readonly Scenario[]): Level2ServiceOptions {
  let ids = 0;
  let ticks = 0;
  return {
    checks,
    tools: async () => [...BUILDER_TOOLS, ...ENGINE_TOOL_SEEDS],
    agents: async () => seededPersonas().map((agent) => agent.slug),
    procedures: async () => ['tool-rounds', 'research'],
    store: db.checks,
    ...grantsActingAsOwner(db.engine),
    builtIn,
    newId: () => `run-${(ids += 1)}`,
    now: () => new Date(Date.parse('2026-10-03T12:00:00Z') + (ticks += 1) * 1000).toISOString(),
  };
}
