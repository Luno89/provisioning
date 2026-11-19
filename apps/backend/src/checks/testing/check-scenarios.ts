import type { Scenario } from '../../eval/level2/scenario.js';
import type { ScenarioResult } from '../../eval/level2/results.js';

export const scenario = (id: string): Scenario => ({ id, name: id, describe: id, agent: 'research', procedure: { id: 'research' }, input: { message: 'go' }, expect: { outcome: 'ok' } });

export const passed = (id: string): ScenarioResult => ({ scenarioId: id, name: id, runId: `run-${id}`, procedure: { id: 'research', version: '1' }, passed: true, outcome: 'ok', answer: '', checks: [], calls: [], counters: { rounds: 1, toolCalls: 0, totalTokens: 1 }, tasks: [], durationMs: 1 });
