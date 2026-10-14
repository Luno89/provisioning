import type { ToolDefinition } from '@koala/agent-engine';

const CATEGORY = {
  type: 'string',
  enum: ['lessons_learned', 'environment_facts', 'prompt_guidance'] as string[],
  description: 'lessons_learned — what went wrong or right and why; environment_facts — what is true about the person\'s setup, projects and services; prompt_guidance — how the person wants things done.',
};

const MODEL = {
  type: 'string',
  description: 'Only when it is about the habits of the model that ran — how it formats calls, what it tends to skip or repeat — and would not hold for another model: that model\'s name, exactly as read_run shows it. It is then recalled only on that model. Leave it out for anything true of the work, the tools or the person.',
};

export const MEMORY_TOOLS: ToolDefinition[] = [
  {
    name: 'search_memories',
    summary: 'Find what is already remembered about something, before saving anything new about it',
    guidance: 'Search before you save, so a fact is updated rather than stored twice. Matching is by words in the title and text.',
    binding: 'platform',
    effect: 'read',
    idempotent: true,
    openWorld: false,
    returns: 'each matching memory with its id, category, scope, the model it is kept for if only one, title and text, best match first — or that nothing matched',
    failures: [{ when: 'no query is given', says: 'to give one' }],
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Words to look for.' } },
      required: ['query'],
    },
  },
  {
    name: 'save_memory',
    summary: 'Remember something that will still matter later — a preference, a decision, a fact about the person\'s setup, a lesson from what went wrong',
    guidance: 'Use this for what stays true past this conversation or run. When it updates something already remembered, name that memory\'s id in replaces, and the old one is retired in its favour. A memory that says exactly what one already says is not stored twice.',
    binding: 'platform',
    effect: 'write',
    idempotent: false,
    openWorld: false,
    destructive: false,
    returns: 'that it was saved, replaced an older memory, or was already known',
    failures: [
      { when: 'there is no text', says: 'what is missing' },
      { when: 'replaces names a memory that is not one of the person\'s current ones', says: 'so, and saves nothing' },
      { when: 'it is scoped to a project and there is no project', says: 'to scope it global instead' },
      { when: 'model is not one of the person\'s models', says: 'to name it exactly as read_run shows it' },
    ],
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A short name for it.' },
        text: { type: 'string', description: 'What to remember, in a sentence or two, specific enough to act on later.' },
        category: CATEGORY,
        scope: { type: 'string', enum: ['project', 'global'], description: 'project — only for work on this project; global — everywhere. Defaults to project when there is one.' },
        replaces: { type: 'string', description: 'The id of the memory this one updates.' },
        model: MODEL,
      },
      required: ['text'],
    },
  },
  {
    name: 'propose_practice',
    summary: 'Propose a practice: a lesson about how one agent should work, which goes into that agent\'s prompt once the bench shows it breaks nothing',
    guidance: 'Use this when a pattern across runs shows how an agent should work differently — the same mistake twice, a judge\'s diagnosis, the person correcting it. Write it as an instruction to that agent, specific enough to follow. It starts on trial: the bench runs the agent\'s scenarios with it, and it goes live only if nothing regresses; otherwise it waits for the person.',
    binding: 'platform',
    effect: 'propose',
    idempotent: false,
    openWorld: false,
    returns: 'that it is on trial, or why it was not proposed',
    failures: [
      { when: 'the agent does not exist', says: 'so' },
      { when: 'the agent already has that practice', says: 'so, and proposes nothing' },
      { when: 'model is not one of the person\'s models', says: 'to name it exactly as read_run shows it' },
    ],
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'The agent it is for.' },
        title: { type: 'string', description: 'A short name for it.' },
        text: { type: 'string', description: 'The practice, as an instruction to the agent.' },
        why: { type: 'string', description: 'What it was learned from, naming runs when there are some.' },
        model: { ...MODEL, description: 'Only when the practice corrects a habit of the model that ran rather than how the agent should work on any model: that model\'s name, exactly as read_run shows it. The bench then tries it on that model, and it reaches the agent\'s prompt only on that model.' },
      },
      required: ['agent', 'text', 'why'],
    },
  },
  {
    name: 'propose_tool_note',
    summary: 'Propose a note on how to use one tool, or the tools of one MCP server, which is shown beside it once the bench shows it breaks nothing',
    guidance: 'Use this when runs show a tool being misused in the same way — called when another fits, called in the wrong order, given arguments it refuses, its result misread — and a sentence beside the tool would prevent it for every agent that holds it. Write it as advice about the tool, not about one agent\'s work: that is a practice. It starts on trial: the bench runs the checks that use the tool with it, and it goes live only if a check that failed before now passes and nothing regresses; otherwise it waits for the person.',
    binding: 'platform',
    effect: 'propose',
    idempotent: false,
    openWorld: false,
    returns: 'that it is on trial, or why it was not proposed',
    failures: [
      { when: 'there is no such tool or server', says: 'so' },
      { when: 'the tool already has that note', says: 'so, and proposes nothing' },
      { when: 'model is not one of the person\'s models', says: 'to name it exactly as read_run shows it' },
    ],
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'The tool, named exactly as it is offered (a server\'s tool as <server>__<tool>). Leave it out for a note on a whole server.' },
        server: { type: 'string', description: 'Only for a note about every tool of one MCP server: the server\'s name.' },
        title: { type: 'string', description: 'A short name for it.' },
        text: { type: 'string', description: 'The note, as advice to whoever is offered the tool.' },
        why: { type: 'string', description: 'What it was learned from, naming runs when there are some.' },
        model: { ...MODEL, description: 'Only when the note corrects how the model that ran tends to use the tool, and would not hold for another model: that model\'s name, exactly as read_run shows it. The bench then tries it on that model, and it is shown only on that model.' },
      },
      required: ['text', 'why'],
    },
  },
  {
    name: 'forget_memory',
    summary: 'Retire a memory that is no longer true',
    guidance: 'Use this when something remembered has turned out wrong and there is nothing to replace it with. The memory stops being recalled; it is kept, marked retired, so a person can see what was forgotten and why.',
    binding: 'platform',
    effect: 'write',
    idempotent: true,
    openWorld: false,
    destructive: false,
    returns: 'that it was retired',
    failures: [{ when: 'the id is not one of the person\'s current memories', says: 'so' }],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The memory to retire.' },
        why: { type: 'string', description: 'What showed it is no longer true.' },
      },
      required: ['id', 'why'],
    },
  },
];
