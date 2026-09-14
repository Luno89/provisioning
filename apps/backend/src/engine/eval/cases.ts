import type { Expectation } from './score.js';
import type { ToolDefinition } from '../catalogue.js';

export type Category = 'simple' | 'multiple' | 'irrelevance';

export interface EvalCase {
  name: string;
  category: Category;
  agent: string;
  say: string;
  expect: Expectation;
  repeats?: number | undefined;
  provokes?: { tool: string; when: string } | undefined;
}

export const BUILDER_CASES: EvalCase[] = [
  {
    name: 'read/by-name',
    category: 'simple',
    agent: 'agent-builder',
    say: 'Show me how the research agent is set up.',
    expect: { tool: 'read_agent', args: [{ arg: 'agent', is: 'research' }] },
  },
  {
    name: 'read/before-editing',
    category: 'multiple',
    agent: 'agent-builder',
    say: 'I want a version of the executor agent that also searches the web. Start by looking at it.',
    expect: { tool: 'read_agent', args: [{ arg: 'agent', is: 'executor' }] },
  },
  {
    name: 'compile/checks-before-writing',
    category: 'multiple',
    agent: 'agent-builder',
    say: [
      'Check whether this is valid before saving anything:',
      '',
      'agent tidy v1',
      '  loop  tool-rounds',
      '  tools read_file',
    ].join('\n'),
    expect: {
      tool: 'compile_agent',
      args: [{ arg: 'source', contains: 'agent tidy' }],
    },
  },
  {
    name: 'write/saves-a-new-agent',
    category: 'simple',
    agent: 'agent-builder',
    say: [
      'Save this exactly as it is, it has already been checked:',
      '',
      'agent tidy v1',
      '  loop  tool-rounds',
      '  tools read_file',
    ].join('\n'),
    expect: {
      tool: 'write_agent',
      args: [
        { arg: 'source', contains: 'agent tidy' },
        { arg: 'source', matches: 'loop\\s+tool-rounds' },
      ],
    },
  },
  {
    name: 'write/writes-the-whole-source',
    category: 'simple',
    agent: 'agent-builder',
    say: 'Write and save an agent called "sifter" that runs the tool-rounds loop and can read files.',
    expect: {
      tool: 'write_agent',
      args: [
        { arg: 'source', contains: 'agent sifter' },
        { arg: 'source', contains: 'loop' },
        { arg: 'source', nonEmpty: true },
      ],
    },
  },
  {
    name: 'irrelevance/answers-a-question',
    category: 'irrelevance',
    agent: 'agent-builder',
    say: 'In one sentence, what is the difference between an agent and the loop it runs?',
    expect: { tool: null },
  },
  {
    name: 'irrelevance/declines-what-it-cannot-do',
    category: 'irrelevance',
    agent: 'agent-builder',
    say: 'Deploy the billing service to the production cluster right now.',
    expect: { tool: null },
  },
];

export function casesFor(tool: string, all: readonly EvalCase[] = BUILDER_CASES): EvalCase[] {
  return all.filter((entry) => entry.expect.tool === tool);
}

export interface SuiteProblem {
  case: string;
  message: string;
}

export function checkSuite(
  catalogue: readonly ToolDefinition[],
  cases: readonly EvalCase[],
): SuiteProblem[] {
  const problems: SuiteProblem[] = [];
  const names = catalogue.map((tool) => tool.name);
  const seen = new Set<string>();

  for (const entry of cases) {
    if (seen.has(entry.name)) problems.push({ case: entry.name, message: 'is defined twice' });
    seen.add(entry.name);

    if (!entry.say.trim()) problems.push({ case: entry.name, message: 'says nothing to the agent' });

    if (entry.expect.tool !== null && !names.includes(entry.expect.tool)) {
      problems.push({ case: entry.name, message: `expects ${entry.expect.tool}, which is not a tool` });
    }

    if (entry.category === 'irrelevance' && entry.expect.tool !== null) {
      problems.push({ case: entry.name, message: 'is an irrelevance case but expects a tool call' });
    }

    const provoked = entry.provokes;
    if (provoked) {
      const tool = catalogue.find((candidate) => candidate.name === provoked.tool);
      if (!tool) {
        problems.push({ case: entry.name, message: `provokes ${provoked.tool}, which is not a tool` });
      } else if (!tool.failures.some((failure) => failure.when === provoked.when)) {
        problems.push({
          case: entry.name,
          message: `provokes "${provoked.when}", which ${provoked.tool} does not list as a failure`,
        });
      }
    }
  }

  for (const tool of catalogue) {
    if (!cases.some((entry) => entry.expect.tool === tool.name)) {
      problems.push({ case: tool.name, message: `has no case that calls ${tool.name}` });
    }

    for (const failure of tool.failures) {
      const covered = cases.some((entry) =>
        entry.provokes?.tool === tool.name && entry.provokes.when === failure.when);

      if (!covered) {
        problems.push({
          case: tool.name,
          message: `nothing provokes "${failure.when}", which it says it can fail on`,
        });
      }
    }
  }

  if (!cases.some((entry) => entry.category === 'irrelevance')) {
    problems.push({ case: '(suite)', message: 'has no irrelevance case, so nothing checks it can leave a tool alone' });
  }

  return problems;
}
