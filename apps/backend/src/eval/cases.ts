import type { Expectation } from './score.js';
import type { ToolDefinition } from '@koala/agent-engine';
import { EXAMPLE_PROCEDURE } from '@koala/agent-engine/procedure';

export type Category = 'simple' | 'multiple' | 'irrelevance';

export const CATEGORIES: readonly Category[] = ['simple', 'multiple', 'irrelevance'];

export interface EvalCase {
  name: string;
  ownerId?: string | undefined;
  updatedAt?: string | undefined;
  category: Category;
  agent: string;
  say: string;
  expect: Expectation;
  repeats?: number | undefined;
  provokes?: { tool: string; when: string } | undefined;
}

export const BUILDER_CASES: EvalCase[] = [
  {
    name: 'list/before-naming-anything',
    category: 'simple',
    agent: 'agent-builder',
    say: 'What tools can a procedure call here?',
    expect: { tool: 'list_references' },
  },
  {
    name: 'read/by-name',
    category: 'simple',
    agent: 'agent-builder',
    say: 'Show me how the research procedure is set up.',
    expect: { tool: 'read_procedure', args: [{ arg: 'procedure', is: 'research' }] },
  },
  {
    name: 'read/before-editing',
    category: 'multiple',
    agent: 'agent-builder',
    say: 'I want a version of the planning procedure with a tighter budget. Start by looking at it.',
    expect: { tool: 'read_procedure', args: [{ arg: 'procedure', is: 'planning' }] },
  },
  {
    name: 'check/without-saving',
    category: 'multiple',
    agent: 'agent-builder',
    say: [
      'Check whether this is valid before saving anything:',
      '',
      JSON.stringify({ ...EXAMPLE_PROCEDURE, id: 'tidy', name: 'Tidy' }, null, 2),
    ].join('\n'),
    expect: {
      tool: 'check_procedure',
      args: [{ arg: 'source', contains: 'tidy' }],
    },
  },
  {
    name: 'save/what-it-was-given',
    category: 'simple',
    agent: 'agent-builder',
    say: [
      'Save this exactly as it is, it has already been checked:',
      '',
      JSON.stringify({ ...EXAMPLE_PROCEDURE, id: 'tidy', name: 'Tidy' }, null, 2),
    ].join('\n'),
    expect: {
      tool: 'save_procedure',
      args: [
        { arg: 'source', contains: 'tidy' },
        { arg: 'source', matches: '"schema"' },
      ],
    },
  },
  {
    name: 'save/the-whole-source',
    category: 'simple',
    agent: 'agent-builder',
    say: 'Write and save a procedure called "sifter" that lets the model think, run whatever tools it asks for, and stop when it is done.',
    expect: {
      tool: 'save_procedure',
      args: [
        { arg: 'source', contains: 'sifter' },
        { arg: 'source', matches: '"finish"' },
        { arg: 'source', nonEmpty: true },
      ],
    },
  },
  {
    name: 'irrelevance/answers-a-question',
    category: 'irrelevance',
    agent: 'agent-builder',
    say: 'In one sentence, what is the difference between a persona and the procedure it runs?',
    expect: { tool: null },
  },
  {
    name: 'irrelevance/declines-what-it-cannot-do',
    category: 'irrelevance',
    agent: 'agent-builder',
    say: 'Deploy the billing service to the production cluster right now.',
    expect: { tool: null },
  },
  {
    name: 'delivery/lists-ready-work',
    category: 'simple',
    agent: 'delivery',
    say: 'What work is ready to start right now?',
    expect: { tool: 'list_tasks', args: [{ arg: 'ready', is: 'true' }] },
  },
  {
    name: 'delivery/declines-doing-the-work',
    category: 'irrelevance',
    agent: 'delivery',
    say: 'Write the migration script yourself and paste it here.',
    expect: { tool: null },
  },
  {
    name: 'executor/claims-a-task',
    category: 'simple',
    agent: 'executor',
    say: 'Start on task t-42.',
    expect: { tool: 'start_task', args: [{ arg: 'taskId', is: 't-42' }] },
  },
  {
    name: 'executor/records-it-finished',
    category: 'simple',
    agent: 'executor',
    say: 'Task t-42 is finished — the suite passes with 14 green. Record it.',
    expect: { tool: 'mark_done', args: [{ arg: 'taskId', is: 't-42' }] },
  },
  {
    name: 'executor/reads-a-named-file',
    category: 'simple',
    agent: 'executor',
    say: 'Show me what is in package.json.',
    expect: { tool: 'read_file', args: [{ arg: 'path', contains: 'package.json' }] },
  },
  {
    name: 'executor/lists-a-directory',
    category: 'simple',
    agent: 'executor',
    say: 'What files are in the src directory?',
    expect: { tool: 'list_dir', args: [{ arg: 'path', contains: 'src' }] },
  },
  {
    name: 'executor/writes-a-file',
    category: 'simple',
    agent: 'executor',
    say: 'Create a file at notes/todo.md containing the single line "check the indexes".',
    expect: {
      tool: 'write_file',
      args: [
        { arg: 'path', contains: 'notes/todo.md' },
        { arg: 'content', contains: 'check the indexes' },
      ],
    },
  },
  {
    name: 'executor/shells-out-when-nothing-else-fits',
    category: 'simple',
    agent: 'executor',
    say: 'Run the test suite and tell me what fails.',
    expect: { tool: 'run_command', args: [{ arg: 'command', nonEmpty: true }] },
  },
  {
    name: 'executor/answers-without-touching-the-workspace',
    category: 'irrelevance',
    agent: 'executor',
    say: 'In one sentence, what does it mean for a task to be blocked?',
    expect: { tool: null },
  },
  {
    name: 'research/searches-for-a-fact',
    category: 'simple',
    agent: 'research',
    say: 'Which company originally developed the Rust programming language?',
    expect: { tool: 'search_web', args: [{ arg: 'query', nonEmpty: true }] },
  },
  {
    name: 'research/reads-a-page-it-was-given',
    category: 'simple',
    agent: 'research',
    say: 'Read https://example.com/pricing and tell me what the tiers are.',
    expect: { tool: 'fetch_web_page', args: [{ arg: 'url', contains: 'example.com/pricing' }] },
  },
  {
    name: 'research/declines-what-the-web-cannot-answer',
    category: 'irrelevance',
    agent: 'research',
    say: 'Which of our clusters is running low on disk?',
    expect: { tool: null },
  },
];

export function casesFor(tool: string, all: readonly EvalCase[] = BUILDER_CASES): EvalCase[] {
  return all.filter((entry) => entry.expect.tool === tool);
}

export type SuiteProblemKind = 'uncovered' | 'unprovoked' | 'malformed';

export interface SuiteProblem {
  case: string;
  message: string;
  kind: SuiteProblemKind;
}

export interface Provocation {
  tool: string;
  when: string;
}

export function checkSuite(
  catalogue: readonly ToolDefinition[],
  cases: readonly EvalCase[],
  provokedByScenarios: readonly Provocation[] = [],
): SuiteProblem[] {
  const problems: SuiteProblem[] = [];
  const names = catalogue.map((tool) => tool.name);
  const seen = new Set<string>();

  for (const entry of cases) {
    if (seen.has(entry.name)) problems.push({ case: entry.name, message: 'is defined twice', kind: 'malformed' });
    seen.add(entry.name);

    if (!entry.say.trim()) problems.push({ case: entry.name, message: 'says nothing to the agent', kind: 'malformed' });

    if (entry.expect.tool !== null && !names.includes(entry.expect.tool)) {
      problems.push({ case: entry.name, message: `expects ${entry.expect.tool}, which is not a tool`, kind: 'malformed' });
    }

    if (entry.category === 'irrelevance' && entry.expect.tool !== null) {
      problems.push({ case: entry.name, message: 'is an irrelevance case but expects a tool call', kind: 'malformed' });
    }

    const provoked = entry.provokes;
    if (provoked) {
      const tool = catalogue.find((candidate) => candidate.name === provoked.tool);
      if (!tool) {
        problems.push({ case: entry.name, message: `provokes ${provoked.tool}, which is not a tool`, kind: 'malformed' });
      } else if (!tool.failures.some((failure) => failure.when === provoked.when)) {
        problems.push({
          case: entry.name,
          message: `provokes "${provoked.when}", which ${provoked.tool} does not list as a failure`,
          kind: 'malformed',
        });
      }
    }
  }

  for (const tool of catalogue) {
    if (!cases.some((entry) => entry.expect.tool === tool.name)) {
      problems.push({ case: tool.name, message: `has no case that calls ${tool.name}`, kind: 'uncovered' });
    }

    for (const failure of tool.failures) {
      const covered = cases.some((entry) => entry.provokes?.tool === tool.name && entry.provokes.when === failure.when)
        || provokedByScenarios.some((provoked) => provoked.tool === tool.name && provoked.when === failure.when);

      if (!covered) {
        problems.push({
          case: tool.name,
          message: `nothing provokes "${failure.when}", which it says it can fail on`,
          kind: 'unprovoked',
        });
      }
    }
  }

  if (!cases.some((entry) => entry.category === 'irrelevance')) {
    problems.push({
      case: '(suite)',
      message: 'has no irrelevance case, so nothing checks it can leave a tool alone',
      kind: 'malformed',
    });
  }

  return problems;
}

const CASE_NAME = /^[a-z0-9-]+\/[a-z0-9-]+$/;
const ARG_KINDS = ['is', 'contains', 'matches', 'nonEmpty'] as const;

export function caseProblems(value: unknown, known: { agents: ReadonlySet<string>; tools: readonly ToolDefinition[] }): string[] {
  if (typeof value !== 'object' || value === null) return ['a case has to be an object'];
  const entry = value as Partial<EvalCase>;
  const problems: string[] = [];
  if (typeof entry.name !== 'string' || !CASE_NAME.test(entry.name)) problems.push('the name has to look like group/what-it-checks, in lower case');
  if (!CATEGORIES.includes(entry.category as Category)) problems.push(`the category has to be one of ${CATEGORIES.join(', ')}`);
  if (typeof entry.agent !== 'string' || !known.agents.has(entry.agent)) problems.push(`there is no agent called "${String(entry.agent)}"`);
  if (typeof entry.say !== 'string' || !entry.say.trim()) problems.push('the case has to say something to the agent');
  if (entry.repeats !== undefined && (!Number.isInteger(entry.repeats) || entry.repeats < 1 || entry.repeats > 25)) problems.push('repeats has to be a whole number from 1 to 25');

  const expected = entry.expect;
  if (!expected || (expected.tool !== null && typeof expected.tool !== 'string')) {
    problems.push('the case has to say which tool it expects, or null for none');
  } else {
    const tool = expected.tool === null ? undefined : known.tools.find((candidate) => candidate.name === expected.tool);
    if (expected.tool !== null && !tool) problems.push(`it expects ${expected.tool}, which is not a tool`);
    if (entry.category === 'irrelevance' && expected.tool !== null) problems.push('an irrelevance case expects no tool call');
    for (const check of expected.args ?? []) {
      const kinds = ARG_KINDS.filter((kind) => kind in check);
      if (typeof check.arg !== 'string' || !check.arg || kinds.length !== 1) problems.push('each argument check names one argument and one of is, contains, matches or nonEmpty');
      else if (tool && !(check.arg in (tool.parameters.properties ?? {}))) problems.push(`${tool.name} has no argument called "${check.arg}"`);
      else if ('matches' in check) {
        try {
          new RegExp(check.matches);
        } catch {
          problems.push(`"${check.matches}" is not a valid pattern`);
        }
      }
    }
  }

  if (entry.provokes) {
    const tool = known.tools.find((candidate) => candidate.name === entry.provokes!.tool);
    if (!tool) problems.push(`it provokes ${entry.provokes.tool}, which is not a tool`);
    else if (!tool.failures.some((failure) => failure.when === entry.provokes!.when)) problems.push(`${tool.name} does not list "${entry.provokes.when}" as a failure`);
  }
  return problems;
}
