import type { ToolDefinition } from '@koala/agent-engine';

const CATEGORY = {
  type: 'string',
  enum: ['lessons_learned', 'environment_facts', 'prompt_guidance'] as string[],
  description: 'lessons_learned — what went wrong or right and why; environment_facts — what is true about the person\'s setup, projects and services; prompt_guidance — how the person wants things done.',
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
    returns: 'each matching memory with its id, category, scope, title and text, best match first — or that nothing matched',
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
    ],
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A short name for it.' },
        text: { type: 'string', description: 'What to remember, in a sentence or two, specific enough to act on later.' },
        category: CATEGORY,
        scope: { type: 'string', enum: ['project', 'global'], description: 'project — only for work on this project; global — everywhere. Defaults to project when there is one.' },
        replaces: { type: 'string', description: 'The id of the memory this one updates.' },
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
    ],
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'The agent it is for.' },
        title: { type: 'string', description: 'A short name for it.' },
        text: { type: 'string', description: 'The practice, as an instruction to the agent.' },
        why: { type: 'string', description: 'What it was learned from, naming runs when there are some.' },
      },
      required: ['agent', 'text', 'why'],
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
