import { describe, it, expect } from 'vitest';
import type { ToolDefinition } from '@koala/agent-engine';
import { checkCoverage } from './check-coverage.js';
import type { Scenario } from '../eval/level2/scenario.js';

const tool = (name: string, failures: string[] = []): ToolDefinition => ({
  name, summary: '', guidance: '', binding: 'environment', effect: 'read', idempotent: true, openWorld: false, returns: '',
  failures: failures.map((when) => ({ when, says: 'so' })),
  parameters: { type: 'object', properties: {} },
}) as ToolDefinition;

const run = (agent: string, expect: Scenario['expect']): Scenario => ({ id: 'r', name: 'r', describe: 'r', agent, procedure: { id: 'p' }, input: { message: 'go' }, expect });
const turn = (agent: string, chooses: string | null): Scenario => ({ ...run(agent, { chooses: { tool: chooses } }), procedure: { id: 'turn-check' }, turn: true });

describe('what the checks leave uncovered', () => {
  it('names a tool no check touches, and a failure nothing provokes', () => {
    const gaps = checkCoverage([tool('read_file', ['the file does not exist']), tool('list_dir')], [turn('executor', 'list_dir'), turn('executor', null)]);

    expect(gaps.map((gap) => gap.message)).toEqual([
      'no check touches read_file',
      'nothing provokes "the file does not exist", which read_file says it can fail on',
    ]);
  });

  it('counts a tool any kind of check touches, and a provocation in any stage', () => {
    const check = { ...run('executor', { toolsCalled: ['read_file'] }), then: [{ name: 'again', do: { chat: { message: 'again' } }, expect: { provokes: { tool: 'read_file', when: 'the file does not exist', then: 'reported' as const } } }] };
    expect(checkCoverage([tool('read_file', ['the file does not exist'])], [check])).toEqual([]);
  });

  it('names an agent whose turn checks never expect it to leave its tools alone', () => {
    const gaps = checkCoverage([tool('list_dir')], [turn('executor', 'list_dir'), turn('research', 'list_dir'), turn('research', null)]);
    expect(gaps).toEqual([{ kind: 'no-restraint', agent: 'executor', message: 'no turn check of executor expects it to answer without a tool, so nothing checks it can leave its tools alone' }]);
  });
});
