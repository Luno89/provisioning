import type { ToolDefinition } from './catalogue.js';

const LOOP_EDITING = [
  'add_validation_step', 'add_validation_group', 'add_validation_loop',
  'revise_validation_step', 'remove_validation_step', 'reorder_validation_steps',
  'add_workflow_stage', 'add_workflow_group', 'add_workflow_loop',
  'revise_workflow_stage', 'remove_workflow_stage', 'reorder_workflow_stages',
];

export const BUILDER_TOOLS: ToolDefinition[] = [
  {
    name: 'list_references',
    summary: 'List all tools and persona agents available in the platform that a procedure can reference or delegate to',
    guidance: 'Use this before authoring a procedure that names a specific tool or persona agent, so the '
      + 'names are valid. The tools listed in your own prompt are the ones YOU can call; a '
      + 'procedure may name any tool that exists, which is a larger set — so answer a question '
      + 'about what a procedure can use from here, never from your own tool list. A procedure that '
      + 'only uses a Model Turn names no specific tool, so it needs no lookup first.',
    binding: 'platform',
    effect: 'read',
    status: 'draft',
    replaces: ['list_tree_types'],
    returns: 'Every tool name, every persona with what it is for, and every node kind and group a procedure '
      + 'can use, so each node can be pointed at the right one.',
    failures: [
      { when: 'the run has no owner', says: 'lists only what ships as a built-in' },
      { when: 'nothing is declared yet', says: 'none, under whichever list is empty' },
    ],
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'read_procedure',
    summary: 'Read an existing procedure definition as clean JSON by ID, or list all existing procedure IDs',
    guidance: 'Use this when you need the current JSON structure of a procedure that already exists and do '
      + 'not already have it. If the procedure source is already in front of you, or the question is about how things '
      + 'work rather than about one named procedure, this is not the tool. Writing a new procedure '
      + 'does not need a read first — the JSON schema is already in front of you. '
      + 'Editing a built-in gives you your own copy rather than changing it for everyone.',
    binding: 'platform',
    effect: 'read',
    status: 'draft',
    replaces: ['get_tree_type'],
    returns: 'The full JSON definition of the procedure (schema, id, version, name, budget, start, nodes, wires, flow), in the same format save_procedure takes.',
    failures: [
      { when: 'no procedure has that id', says: 'there is no procedure called "<id>"' },
      { when: 'the procedure argument is left out', says: 'the ids and versions of every procedure that exists' },
    ],
    parameters: {
      type: 'object',
      properties: {
        procedure: {
          type: 'string',
          description: 'The id of the procedure to read, for example "research" or "tool-rounds". Leave it out to list what exists.',
        },
      },
    },
  },
  {
    name: 'check_procedure',
    summary: 'Check a procedure definition against the platform schema and report what is wrong with it. Nothing is saved',
    guidance: 'Use this when you want to know whether a definition holds together and you are not ready to save it. '
      + 'Saving already checks: save_procedure refuses anything that does not check clean, so this is not a step you '
      + 'have to take before saving. Read the problems it lists and fix them in the source you are holding.',
    binding: 'platform',
    effect: 'read',
    status: 'draft',
    replaces: [...LOOP_EDITING, 'compile_procedure'],
    returns: 'Either a confirmation naming what the procedure defines, or the problems, in the '
      + 'form "node \\"step1\\": calls tool \\"ghost_tool\\", which is not available here". Nothing is saved either way.',
    failures: [
      { when: 'the JSON is invalid or does not match schema', says: 'invalid JSON or missing required fields' },
      { when: 'it refers to a tool or persona that does not exist', says: 'what it named and that it does not exist' },
      { when: 'the source argument is missing', says: 'this call needs a "source"' },
    ],
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'The full procedure as a JSON string or object in format 2: "schema": 2, "id", "version", "name", "budget", "start", "nodes" (each { "id", "kind", "settings" }), "wires" joining sockets and "flow" joining exits to steps.',
        },
      },
      required: ['source'],
    },
  },
  {
    name: 'save_procedure',
    summary: 'Save a procedure as your own copy. It checks the definition first and refuses to save anything with problems',
    guidance: 'Use this when you are asked to save or create a procedure. It checks the definition itself and '
      + 'refuses to store anything that does not check clean, so you do not need to check it first — if it comes '
      + 'back refused, fix what it lists and call it again. The source must be clean JSON.',
    binding: 'platform',
    effect: 'write',
    status: 'draft',
    replaces: ['create_tree_type', 'set_tree_type_overview', 'delete_tree_type', 'write_procedure'],
    returns: 'Confirmation naming what was saved, as your own copy. A built-in is never changed; '
      + 'your copy shadows it by id wherever it is referenced.',
    failures: [
      { when: 'the definition has problems', says: 'not saved — it does not check clean, followed by the problems' },
      { when: 'the source defines no procedure', says: 'this source defines no procedure, so there is nothing to save' },
      { when: 'the run has no owner', says: 'this run has no owner to save a procedure for' },
    ],
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'The full procedure to save, as a JSON string or object in format 2: "schema": 2, "id", "version", "name", "budget", "start", "nodes", "wires" and "flow".',
        },
      },
      required: ['source'],
    },
  },
];
