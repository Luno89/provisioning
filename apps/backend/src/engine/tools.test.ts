import { describe, it, expect } from 'vitest';
import { agentAsTool, describeTools, effectiveTools, toolSchemas, type ToolContract } from './tools.js';
import { capabilitiesOf } from './environment.js';

const catalogue: ToolContract[] = [
  { name: 'propose_work', description: 'Propose a unit of work', binding: 'platform' },
  { name: 'search_web', description: 'Search the web', binding: 'network' },
  { name: 'run_command', description: 'Run a shell command', binding: 'environment' },
  { name: 'read_file', description: 'Read a file', binding: 'environment', requires: { filesystem: true } },
  { name: 'run_tests', description: 'Run the test suite', binding: 'environment', requires: { terminal: true, languages: ['node20'] } },
];

const sandboxCaps = capabilitiesOf({ kind: 'sandbox', lifecycle: 'invocation', languages: ['node20'] });
const offlineCaps = capabilitiesOf({ kind: 'sandbox', lifecycle: 'invocation', languages: ['node20'], egress: false });
const noneCaps = capabilitiesOf({ kind: 'none', lifecycle: 'invocation' });

const names = (tools: ToolContract[]) => tools.map((tool) => tool.name);

describe('effectiveTools', () => {
  it('offers every granted tool an environment can actually support', () => {
    const result = effectiveTools({
      granted: ['propose_work', 'search_web', 'run_command'],
      catalogue,
      capabilities: sandboxCaps,
    });

    expect(names(result.tools)).toEqual(['propose_work', 'search_web', 'run_command']);
    expect(result.withheld).toEqual([]);
  });

  it('withholds environment tools when there is no environment, and says why', () => {
    const result = effectiveTools({
      granted: ['propose_work', 'run_command', 'read_file'],
      catalogue,
      capabilities: noneCaps,
    });

    expect(names(result.tools)).toEqual(['propose_work']);
    expect(result.withheld).toEqual([
      { name: 'run_command', why: 'this environment cannot run commands; this environment has no files to read or write' },
      { name: 'read_file', why: 'this environment has no files to read or write' },
    ]);
  });

  it('withholds network tools when the environment has no egress', () => {
    const result = effectiveTools({
      granted: ['search_web', 'run_command'],
      catalogue,
      capabilities: offlineCaps,
    });

    expect(names(result.tools)).toEqual(['run_command']);
    expect(result.withheld).toEqual([
      { name: 'search_web', why: 'this environment cannot reach the network' },
    ]);
  });

  it('withholds a tool whose declared language is missing', () => {
    const python = capabilitiesOf({ kind: 'sandbox', lifecycle: 'invocation', languages: ['python312'] });
    const result = effectiveTools({ granted: ['run_tests'], catalogue, capabilities: python });

    expect(result.tools).toEqual([]);
    expect(result.withheld[0]?.why).toContain('does not have node20');
  });

  it('reports a granted name that is not in the catalogue at all', () => {
    const result = effectiveTools({ granted: ['ghost_tool'], catalogue, capabilities: sandboxCaps });
    expect(result.withheld).toEqual([{ name: 'ghost_tool', why: 'no tool by that name is registered' }]);
  });

  it('offers nothing when the step asks for no tools', () => {
    const result = effectiveTools({
      granted: ['propose_work', 'run_command'],
      catalogue,
      capabilities: sandboxCaps,
      allowed: 'none',
    });

    expect(result.tools).toEqual([]);
    expect(result.withheld).toEqual([
      { name: 'propose_work', why: 'this step offers no tools' },
      { name: 'run_command', why: 'this step offers no tools' },
    ]);
  });

  it('narrows to an explicit per-step list without granting anything extra', () => {
    const result = effectiveTools({
      granted: ['propose_work', 'search_web', 'run_command'],
      catalogue,
      capabilities: sandboxCaps,
      allowed: ['search_web', 'read_file'],
    });

    expect(names(result.tools)).toEqual(['search_web']);
    expect(result.withheld.map((w) => w.name)).toEqual(['propose_work', 'run_command']);
  });

  it('keeps the grant order the agent declared', () => {
    const result = effectiveTools({
      granted: ['run_command', 'propose_work', 'search_web'],
      catalogue,
      capabilities: sandboxCaps,
    });
    expect(names(result.tools)).toEqual(['run_command', 'propose_work', 'search_web']);
  });
});

describe('toolSchemas', () => {
  it('shapes contracts into what an endpoint expects', () => {
    expect(toolSchemas([catalogue[0]!])).toEqual([
      {
        type: 'function',
        function: { name: 'propose_work', description: 'Propose a unit of work', parameters: { type: 'object', properties: {} } },
      },
    ]);
  });
});

describe('describeTools', () => {
  it('describes only what it is given, so withheld tools never reach the prompt', () => {
    const { tools } = effectiveTools({
      granted: ['propose_work', 'search_web'],
      catalogue,
      capabilities: offlineCaps,
    });

    const described = describeTools(tools);
    expect(described).toContain('propose_work');
    expect(described).not.toContain('search_web');
  });

  it('is empty when nothing is available', () => {
    expect(describeTools([])).toBe('');
  });
});

describe('agentAsTool', () => {
  it('presents another agent as an ordinary callable tool', () => {
    const tool = agentAsTool({
      name: 'research',
      description: 'Answer a question with sources',
      inputs: { type: 'object', properties: { question: { type: 'string' } } },
    });

    expect(tool).toMatchObject({ name: 'research', binding: 'platform' });
    expect(toolSchemas([tool])[0]?.function.parameters).toMatchObject({ properties: { question: { type: 'string' } } });
  });
});
