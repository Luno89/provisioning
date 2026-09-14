import type { ToolDefinition } from './catalogue.js';

const LOOP_EDITING = [
  'add_validation_step', 'add_validation_group', 'add_validation_loop',
  'revise_validation_step', 'remove_validation_step', 'reorder_validation_steps',
  'add_workflow_stage', 'add_workflow_group', 'add_workflow_loop',
  'revise_workflow_stage', 'remove_workflow_stage', 'reorder_workflow_stages',
];

export const BUILDER_TOOLS: ToolDefinition[] = [
  {
    name: 'read_agent',
    summary: 'Read an agent and the loop it runs, as editable text in the loop syntax',
    guidance: 'Use this when you need the current text of an agent that already exists and do not '
      + 'already have it. If the source is in front of you, or the question is about how things work '
      + 'rather than about one named agent, this is not the tool. Editing a built-in gives you your '
      + 'own copy rather than changing it for everyone.',
    binding: 'platform',
    effect: 'read',
    status: 'draft',
    replaces: ['get_tree_type', 'list_tree_types'],
    returns: 'The full text of the agent, followed by the text of the loop it runs. This is the same '
      + 'syntax write_agent takes, so it can be edited and written straight back.',
    failures: [
      { when: 'no agent has that slug', says: 'there is no agent called "<slug>"' },
      { when: 'the agent argument is missing or empty', says: 'this call needs an "agent"' },
    ],
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'The slug of the agent to read, for example "research" or "executor"',
        },
      },
      required: ['agent'],
    },
  },
  {
    name: 'compile_agent',
    summary: 'Check agent text without saving it. Returns each problem with the line it is on.',
    guidance: 'Use this when you want to know whether agent text is valid without saving it. If you '
      + 'have been asked to save, use write_agent instead — it runs this same check and refuses '
      + 'anything that fails. Read the problems literally — each names a line — rather than '
      + 'rewriting from scratch.',
    binding: 'platform',
    effect: 'read',
    status: 'draft',
    replaces: LOOP_EDITING,
    returns: 'Either a confirmation naming what the text defines, or one problem per line in the form '
      + '"line 5: calls tool \\"ghost_tool\\", which is not available here". Nothing is ever saved.',
    failures: [
      { when: 'the text does not parse', says: 'line N: the indent, node kind or setting that is wrong' },
      { when: 'it refers to a tool, agent or loop that does not exist', says: 'line N: what it named and that it does not exist' },
      { when: 'a loop can cycle with no budget', says: 'this loop can cycle forever — give it a budget' },
      { when: 'the source argument is missing', says: 'this call needs a "source"' },
    ],
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'The full agent and loop text to check, written in the loop syntax',
        },
      },
      required: ['source'],
    },
  },
  {
    name: 'write_agent',
    summary: 'Save agent text as your own copy. Refuses anything that does not compile.',
    guidance: 'Use this when you are asked to save or create an agent. It compiles the text first and '
      + 'refuses anything that does not, so a separate compile_agent call is not needed. You cannot '
      + 'grant an agent a tool you do not have yourself, and that refusal is not something to work around.',
    binding: 'platform',
    effect: 'write',
    status: 'draft',
    replaces: ['create_tree_type', 'set_tree_type_overview', 'set_tree_type_roles', 'delete_tree_type'],
    returns: 'Confirmation naming what was saved, as your own copy. A built-in is never changed; your '
      + 'copy shadows it by name wherever it is referenced.',
    failures: [
      { when: 'the text does not compile', says: 'not saved — it does not compile, followed by the problems' },
      { when: 'it grants a tool the caller does not have', says: 'not saved — you cannot grant tools you do not have yourself' },
      { when: 'the text defines no agent', says: 'this source defines no agent, so there is nothing to save' },
      { when: 'the run has no owner', says: 'this run has no owner to save an agent for' },
    ],
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'The full agent and loop text to save, written in the loop syntax',
        },
      },
      required: ['source'],
    },
  },
];
