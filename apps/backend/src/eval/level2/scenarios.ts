import { EXAMPLE_PROCEDURE, SINGLE_SHOT_V2 } from '@koala/agent-engine/procedure';
import type { Scenario } from './scenario.js';

export const BUILT_IN_SCENARIOS: readonly Scenario[] = [
  {
    id: 'builder-saves-only-what-checks-clean',
    name: 'The builder saves a procedure it was handed',
    describe: 'Saving checks the definition and refuses anything with problems, so what ends up stored is always valid.',
    agent: 'agent-builder',
    procedure: { id: 'tool-rounds' },
    input: { message: `Save this procedure as "tidy":\n\n${JSON.stringify({ ...EXAMPLE_PROCEDURE, id: 'tidy', name: 'Tidy' }, null, 2)}` },
    expect: {
      outcome: 'ok',
      toolsCalled: ['save_procedure'],
      saved: { procedure: 'tidy', stored: true },
      within: { rounds: 8 },
    },
  },
  {
    id: 'builder-fixes-what-does-not-check',
    name: 'The builder fixes a procedure the store refused',
    describe: 'Handed a definition with a real problem, it should be refused on save, read what the problems say, and fix that rather than rewrite or give up.',
    agent: 'agent-builder',
    procedure: { id: 'tool-rounds' },
    input: {
      message: `Save this procedure as "tidy". Fix anything wrong with it first:\n\n${JSON.stringify(
        { ...EXAMPLE_PROCEDURE, id: 'tidy', name: 'Tidy', start: 'nowhere' },
        null,
        2,
      )}`,
    },
    expect: {
      outcome: 'ok',
      toolsCalled: ['save_procedure'],
      saved: { procedure: 'tidy', stored: true },
      within: { rounds: 12 },
    },
  },
  {
    id: 'builder-reads-before-changing',
    name: 'The builder reads a procedure before changing it',
    describe: 'Asked to change a procedure that already exists, it should read the stored one rather than inventing it.',
    agent: 'agent-builder',
    procedure: { id: 'tool-rounds' },
    input: { message: 'The "triage" procedure finishes with outcome ok. Read it, then save it again with its finish reason set to "sorted".' },
    world: {
      procedures: [{
        ...SINGLE_SHOT_V2,
        id: 'triage',
        version: '1',
        name: 'Triage',
        describe: 'Answers once and stops.',
        nodes: SINGLE_SHOT_V2.nodes.map((node) => (node.id === 'verdict' ? { ...node, settings: { ...node.settings, reason: 'ok' } } : node)),
      }],
    },
    expect: {
      outcome: 'ok',
      toolsInOrder: ['read_procedure', 'save_procedure'],
    },
  },
  {
    id: 'builder-reports-a-missing-procedure',
    name: 'The builder says when a procedure does not exist',
    describe: 'Asked about something that is not there, the read has to fail and the answer has to say so rather than invent one.',
    agent: 'agent-builder',
    procedure: { id: 'tool-rounds' },
    input: { message: 'Show me how the "ghost-procedure" is set up.' },
    expect: {
      outcome: 'ok',
      toolsCalled: ['read_procedure'],
      toolsNotCalled: ['save_procedure'],
      provokes: { tool: 'read_procedure', when: 'no procedure has that id', then: 'reported' },
    },
  },
  {
    id: 'planner-proposes-checkable-work',
    name: 'The planner turns a goal into tasks',
    describe: 'A goal should come back as proposed work with what done means, not as prose.',
    agent: 'planner',
    procedure: { id: 'planning' },
    input: { message: 'Add a GET /healthz endpoint that returns {"ok":true} to a small Express app.' },
    expect: {
      outcome: 'ok',
      toolsCalled: ['propose_work'],
      within: { rounds: 8 },
    },
  },
  {
    id: 'executor-does-one-task',
    name: 'The executor finishes a task in its sandbox',
    describe: 'It should claim the task, write the file in its own sandbox, and record the task done with evidence.',
    agent: 'executor',
    procedure: { id: 'do-one-task' },
    input: {
      message: 'Do the task you have been given.',
      inputs: {
        item: {
          id: 'write-greeting',
          title: 'Write hello.txt',
          doneMeans: 'A file called hello.txt exists in the workspace and contains exactly the word hello, with no trailing newline.',
        },
      },
    },
    world: {
      tasks: [{
        id: 'write-greeting',
        title: 'Write hello.txt',
        doneMeans: 'A file called hello.txt exists in the workspace and contains exactly the word hello, with no trailing newline.',
        status: 'accepted',
      }],
    },
    expect: {
      outcome: 'ok',
      toolsInOrder: ['start_task', 'mark_done'],
      tasks: [{ id: 'write-greeting', status: 'done' }],
    },
  },
  {
    id: 'executor-reads-what-is-there',
    name: 'The executor answers from a file in its workspace',
    describe: 'Asked what a file says, it should read that file rather than guess.',
    agent: 'executor',
    procedure: { id: 'tool-rounds' },
    input: { message: 'What does notes/todo.md say? Quote it back to me.' },
    world: { files: { 'notes/todo.md': 'check the indexes before the release\n' } },
    expect: {
      outcome: 'ok',
      toolsCalled: ['read_file'],
      within: { rounds: 8 },
    },
  },
  {
    id: 'research-answers-from-the-web',
    name: 'Research answers a question from the web',
    describe: 'A question it cannot know should send it to the web and come back with an answer.',
    agent: 'research',
    procedure: { id: 'research' },
    input: { message: 'Which company originally developed the Rust programming language? Say where you found it.' },
    expect: {
      outcome: 'ok',
      toolsCalled: ['search_web'],
    },
  },
  {
    id: 'delivery-plans-and-delivers',
    name: 'Delivery plans work, waits to be told, then has it done',
    describe: 'The planner proposes, a person accepts on the task board and answers, and an executor finishes what is ready.',
    agent: 'delivery',
    procedure: { id: 'delivery' },
    input: {
      message: 'Create a file called hello.txt in the workspace containing exactly the word hello.',
      inputs: { goal: 'Create a file called hello.txt in the workspace containing exactly the word hello.' },
    },
    world: { acceptProposedWork: true },
    answers: { review: 'Accepted on the board. Carry on.' },
    expect: {
      outcome: 'ok',
      toolsInOrder: ['propose_work', 'list_tasks', 'start_task', 'mark_done'],
    },
  },
];
