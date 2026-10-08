import { describe, it, expect } from 'vitest';
import { scenarioProblems, type Scenario } from './scenario.js';

const scenario = (expectations: Scenario['expect']): Scenario => ({
  id: 'fan-out',
  name: 'Fans research out',
  describe: 'Koala asks research several questions at once.',
  agent: 'koala',
  procedure: { id: 'interactive-chat' },
  input: { message: 'look three things up' },
  expect: expectations,
});

const known = { agents: new Set(['koala', 'research']), procedures: new Set(['interactive-chat']), tools: [] };

describe('what a scenario can expect of hand-offs and files', () => {
  it('accepts hand-offs to a known agent and files inside the workspace', () => {
    expect(scenarioProblems(scenario({ handOffs: [{ agent: 'research', atLeast: 2, together: true }], files: [{ path: 'research/findings.md', contains: ['5432'] }] }), known)).toEqual([]);
  });

  it('refuses hand-offs to an unknown agent, a count that is not one, and a path outside the workspace', () => {
    expect(scenarioProblems(scenario({
      handOffs: [{ agent: 'ghost' }, { agent: 'research', atLeast: -1 }],
      files: [{ path: '/etc/passwd' }, { path: '../out.md' }],
    }), known)).toEqual([
      'it expects hand-offs to "ghost", which is not an agent',
      'a count of hand-offs to research has to be a whole number',
      '"/etc/passwd" is not a path inside the workspace — give it relative to /work, without ..',
      '"../out.md" is not a path inside the workspace — give it relative to /work, without ..',
    ]);
  });
});

describe('a step check taken from a procedure', () => {
  const step = (from: unknown): Scenario => ({ ...scenario({ exit: 'yes' }), procedure: { id: 'step-check-fan-out' }, step: { node: 'decide', settings: { question: 'Done?' }, from } as never });

  it('may say which procedure it was taken from, by its id', () => {
    expect(scenarioProblems(step('interactive-chat'), known)).toEqual([]);
    expect(scenarioProblems(step(7), known)).toEqual(['its step: "from" names the procedure the step was taken from']);
  });
});

describe('what a step check can expect of its node', () => {
  const step = (expect: Scenario['expect']): Scenario => ({ ...scenario(expect), procedure: { id: 'step-check-fan-out' }, step: { node: 'call-tool', settings: { tool: 'write_file' } } });

  it('names the exits and outputs the node really has when a check expects one it does not', () => {
    expect(scenarioProblems(step({ exit: 'error' }), known)).toEqual(['call-tool leaves by "ok" or "failed", never "error"']);
    expect(scenarioProblems(step({ outputs: { stdout: { contains: 'x' } } }), known)[0]).toMatch(/^call-tool has no output "stdout" — it has "/);
    expect(scenarioProblems(step({ exit: 'failed', outputs: { text: { contains: 'nothing was written' } } }), known)).toEqual([]);
  });
});

describe('a turn check', () => {
  const readFile = { name: 'read_file', summary: '', guidance: '', binding: 'environment', effect: 'read', idempotent: true, openWorld: false, returns: '', failures: [], parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } as never;
  const turn = (over: Partial<Scenario> = {}): Scenario => ({
    ...scenario({ chooses: { tool: 'read_file', args: [{ arg: 'path', contains: 'package.json' }] } }),
    procedure: { id: 'turn-check' },
    turn: true,
    ...over,
  });
  const withTools = { ...known, tools: [readFile] };

  it('expects what the model chooses, repeated as often as it likes up to 25', () => {
    expect(scenarioProblems(turn({ repeats: 5, passAt: 4 }), withTools)).toEqual([]);
  });

  it('runs the turn procedure, chooses something, and expects nothing a run would have to do', () => {
    expect(scenarioProblems(turn({ procedure: { id: 'interactive-chat' } }), withTools)).toEqual(['a turn check runs the procedure made for it, turn-check']);
    expect(scenarioProblems(turn({ expect: { outcome: 'ok' } }), withTools)).toEqual([
      'a turn check has to expect what the model chooses',
      'nothing runs in a turn check, so it can only expect chooses and modelSaw, not outcome',
    ]);
  });

  it('is the only kind of check that can expect a choice', () => {
    expect(scenarioProblems(scenario({ chooses: { tool: 'read_file' } }), withTools)).toEqual(['only a turn check can expect what the model chooses — set turn to true']);
  });

  it('refuses repeats out of range and a passAt above them', () => {
    expect(scenarioProblems(turn({ repeats: 0 }), withTools)).toContain('repeats has to be a whole number from 1 to 25');
    expect(scenarioProblems(turn({ repeats: 3, passAt: 4 }), withTools)).toEqual(['passAt has to be a whole number from 1 to its repeats (3)']);
  });
});
