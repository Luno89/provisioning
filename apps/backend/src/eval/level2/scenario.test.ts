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
    expect(scenarioProblems(turn({ onBench: 'no' as unknown as boolean }), withTools)).toEqual(['onBench has to be true or false']);
    expect(scenarioProblems(turn({ onBench: false }), withTools)).toEqual([]);
  });
});

describe('a check that releases a project', () => {
  const known = { agents: new Set(['planner']), procedures: new Set(['planning']), tools: [] };
  const base = { id: 'story', name: 'Story', describe: 'releases', agent: 'planner', procedure: { id: 'planning' }, input: { message: 'Plan it.' }, expect: { outcome: 'ok' } };

  it('needs the project its world declares, and specs under e2e/', () => {
    expect(scenarioProblems({ ...base, then: [{ name: 'wait', do: { waitRelease: { state: 'live' } } }] }, known)).toContain('a check can only release a project its world declares or an approved plan made');
    expect(scenarioProblems({ ...base, then: [{ name: 'wait', do: { waitRelease: { state: 'live' } } }, { name: 'approve', do: { approvePlan: true } }] }, known)).toContain('a check can only release a project its world declares or an approved plan made');
    expect(scenarioProblems({ ...base, then: [{ name: 'gone', do: { deleteProject: true } }] }, known)).toContain('a check can only delete a project its world declares or an approved plan made');
    expect(scenarioProblems({ ...base, then: [{ name: 'approve', do: { approvePlan: true } }, { name: 'wait', do: { waitRelease: { state: 'live' } } }, { name: 'gone', do: { deleteProject: true } }] }, known).filter((problem) => problem.includes('project'))).toEqual([]);
    expect(scenarioProblems({ ...base, world: { project: { name: 'shop' } }, then: [
      { name: 'wait', do: { waitRelease: { state: 'gone' } } },
      { name: 'look', do: { browse: { release: 'live', specs: { 'tests/a.ts': 'x', 'e2e/../b.spec.ts': 'y' } } } },
    ] }, known)).toEqual([
      'stage 2 waits for a release in preview or live',
      'stage 3: "tests/a.ts" has to be a spec under e2e/ ending .spec.ts',
      'stage 3: "e2e/../b.spec.ts" has to be a spec under e2e/ ending .spec.ts',
    ]);
  });

  it('expects browser tests only of a stage that browses, and only in states they can end in', () => {
    expect(scenarioProblems({ ...base, world: { project: { name: 'shop' } }, then: [
      { name: 'cut', do: { cutOver: true }, expect: { e2e: { state: 'passed' }, release: { state: 'gone', e2e: { tests: { a: 'great' } } } } },
      { name: 'look', do: { browse: { release: 'preview' } }, expect: { e2e: { state: 'running', artifacts: -1 } } },
    ] }, known)).toEqual([
      'stage 2 does not browse, so it has no browser tests of its own — expect the release\'s instead',
      'stage 2: "gone" is not a release state',
      'stage 2: the release\'s the browser test "a" can be passed, failed, flaky, skipped, not "great"',
      'stage 3: browser tests end passed, failed or unavailable, never "running"',
      'stage 3: how many browser files are kept has to be a whole number',
    ]);
  });
});

describe('a check that changes a tree type', () => {
  it('lays settings over a type for the check only, and refuses ones that are not settings or that rename it', () => {
    const base = { id: 'c', name: 'c', describe: 'tree type settings', agent: 'planner', procedure: { id: 'planning' }, input: { message: 'x' }, expect: { outcome: 'ok' as const } };
    const known = { tools: [], agents: new Set(['planner']), procedures: new Set(['planning']) };
    expect(scenarioProblems({ ...base, world: { treeTypes: { 'odoo-addons': { env: [{ name: 'A', value: 'b' }] } } } } as never, known as never)).toEqual([]);
    expect(scenarioProblems({ ...base, world: { treeTypes: { 'odoo-addons': 'env' } } } as never, known as never)).toContain('its world\'s settings for the tree type odoo-addons have to be an object');
    expect(scenarioProblems({ ...base, world: { treeTypes: { 'odoo-addons': { id: 'other' } } } } as never, known as never)).toContain('its world\'s settings for the tree type odoo-addons cannot change its id or owner');
  });
});

describe('a check whose world remembers things', () => {
  it('takes memories with a title and a text, kept for every model or for one', () => {
    const base = { id: 'c', name: 'c', describe: 'memories', agent: 'planner', procedure: { id: 'planning' }, input: { message: 'x' }, expect: { outcome: 'ok' as const } };
    const known = { tools: [], agents: new Set(['planner']), procedures: new Set(['planning']) };
    const problems = (memories: unknown) => scenarioProblems({ ...base, world: { memories } } as never, known as never);
    expect(problems([{ title: 'A', text: 'b' }, { title: 'C', text: 'd', model: 'scripted' }])).toEqual([]);
    expect(problems([{ title: 'A', text: '' }])).toContain('every memory in the world needs a title and a text');
    expect(problems([{ title: 'A', text: 'b', model: ' ' }])).toContain('the memory "A" names a model that is not a name');
  });
});

describe('a check that changes an agent', () => {
  it('lays settings over an agent for the check only, grants it real tools, and refuses anything else', () => {
    const base = { id: 'c', name: 'c', describe: 'agent settings', agent: 'planner', procedure: { id: 'planning' }, input: { message: 'x' }, expect: { outcome: 'ok' as const } };
    const known = { tools: [{ name: 'read_file' }], agents: new Set(['planner']), procedures: new Set(['planning']) };
    const problems = (agents: unknown) => scenarioProblems({ ...base, world: { agents } } as never, known as never);
    expect(problems({ planner: { prompt: 'Short.', tools: ['read_file'] } })).toEqual([]);
    expect(problems({ ghost: {} })).toContain('its world changes "ghost", which is not an agent');
    expect(problems({ planner: { tools: 'read_file' } })).toContain('its world\'s tools for planner have to be a list of tool names');
    expect(problems({ planner: { tools: ['teleport'] } })).toContain('its world grants planner "teleport", which is not a tool');
    expect(problems({ planner: { slug: 'other' } })).toContain('its world\'s settings for planner cannot change its slug or owner');
  });
});

describe('approving what waits in a chat', () => {
  const approving = (approvePlan: unknown): Scenario => ({ ...scenario({ outcome: 'ok' }), world: { project: { name: 'shop' } }, then: [{ name: 'approving', do: { approvePlan } as never }] });

  it('approves in the check\'s own conversation or in a story\'s or a feature\'s chat, and refuses anywhere else', () => {
    expect(scenarioProblems(approving(true), known)).toEqual([]);
    expect(scenarioProblems(approving({ in: { story: 'Print the note' } }), known)).toEqual([]);
    expect(scenarioProblems(approving({ in: { feature: 'Delivery note' } }), known)).toEqual([]);
    expect(scenarioProblems(approving({ in: 'channel' }), known)).toEqual(['stage 2 approves what waits in the check\'s own conversation (approvePlan: true), or in a story\'s or a feature\'s chat named by its title']);
  });

  it('refuses a file that must not say something given as anything but words', () => {
    expect(scenarioProblems(scenario({ repository: { of: 'tree', files: [{ path: 'PLAN.md', lacks: [3] as never }] } }), known)).toEqual(['what PLAN.md must not say has to be a list of words']);
  });
});
