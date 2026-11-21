import { defineNode } from '../definition.js';
import type { BuiltInNode } from '../implementation.js';
import { textOf } from './read.js';

export const MEMORY_CATEGORIES = ['lessons_learned', 'environment_facts', 'prompt_guidance'] as const;

const WRITE_SETTINGS = {
  type: 'object',
  properties: {
    category: { type: 'string', title: 'Category', enum: MEMORY_CATEGORIES, default: 'lessons_learned' },
    scope: { type: 'string', title: 'Scope', enum: ['global', 'project'], default: 'global' },
  },
} as const;

const WRITE_INPUTS = [
  { name: 'title', type: 'text', describe: 'A short name for it. Nothing wired means the first line of the text.' },
  { name: 'binding', type: 'modelBinding', describe: 'Wire the model to keep the memory for that model only. Nothing wired means it holds for every model.' },
] as const;

export const recallMemory: BuiltInNode = {
  definition: defineNode({
    kind: 'recall-memory',
    title: 'Recall Memory',
    category: 'memory',
    describe: 'Recalls the owner\'s active memories by meaning through the memory index, with the run\'s task as the query, and renders as many of the most relevant as fit the model\'s context as a prompt section, saying how many were left out. A memory kept for one model is picked only when the wired binding is that model. While the index is down the run goes on without memories, and the chat says so with since and why.',
    role: 'value',
    inputs: [
      { name: 'binding', type: 'modelBinding', describe: 'The model the prompt is for, whose context the memories fit. Nothing wired means memories kept for one model are left out, and the memories fit the context of the model the run itself uses.' },
      { name: 'task', type: 'text', describe: 'What to recall memories for. Nothing wired means the message the run started with.' },
    ],
    outputs: [
      { name: 'memories', type: 'memory', describe: 'The memories picked.' },
      { name: 'text', type: 'text', describe: 'The memory section of the prompt, or nothing if there are none.' },
    ],
    exits: [],
    settings: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          title: 'Scope',
          describe: '"project" only recalls memories for the run\'s project; "global" only the ones that apply everywhere.',
          enum: ['all', 'project', 'global'],
          default: 'all',
        },
      },
    },
    runs: 'activity',
    idempotent: true,
    summarize: (settings) => `recalls the ${textOf(settings, 'scope', 'all')} memories most relevant to the task, as many as fit the context`,
  }),
};

export const pointToMemories: BuiltInNode = {
  definition: defineNode({
    kind: 'point-to-memories',
    title: 'Point to Memories',
    category: 'memory',
    describe: 'For an agent whose own loop manages its context, such as a coding agent on the person\'s machine: names what memory holds for the run\'s task, by title, most relevant first, and tells it to look the memories up itself with search_memories. Memories kept for one model are left out. While the index is down the run goes on, and the agent and the chat are told so with since and why.',
    role: 'value',
    inputs: [
      { name: 'task', type: 'text', describe: 'What to point to memories for. Nothing wired means the message the run started with.' },
    ],
    outputs: [
      { name: 'text', type: 'text', describe: 'What to tell the agent at its start about memory.' },
    ],
    exits: [],
    settings: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          title: 'Scope',
          describe: '"project" only names memories for the run\'s project; "global" only the ones that apply everywhere.',
          enum: ['all', 'project', 'global'],
          default: 'all',
        },
      },
    },
    runs: 'activity',
    idempotent: true,
    summarize: (settings) => `names the ${textOf(settings, 'scope', 'all')} memories relevant to the task, for the agent to look up itself`,
  }),
};

export const saveMemory: BuiltInNode = {
  definition: defineNode({
    kind: 'save-memory',
    title: 'Save Memory',
    category: 'memory',
    describe: 'Writes something worth remembering for later runs, the way the save_memory tool does: the same thing is never stored twice. A project memory is refused when the run has no project, because it could never be recalled.',
    role: 'step',
    inputs: [
      { name: 'text', type: 'text', describe: 'What to remember.', required: true },
      ...WRITE_INPUTS,
    ],
    outputs: [{ name: 'memory', type: 'json', describe: 'The memory as saved.' }],
    exits: [
      { name: 'saved', describe: 'It was saved.' },
      { name: 'refused', describe: 'It could not be saved, and the output says why.' },
    ],
    settings: WRITE_SETTINGS,
    runs: 'activity',
    idempotent: false,
    summarize: (settings) => `saves a ${textOf(settings, 'scope', 'global')} ${textOf(settings, 'category', 'lessons_learned').replace(/_/g, ' ')} memory`,
  }),
};

export const updateMemory: BuiltInNode = {
  definition: defineNode({
    kind: 'update-memory',
    title: 'Update Memory',
    category: 'memory',
    describe: 'Replaces one of the owner\'s memories with what it is given. The old one is retired in favour of the new and kept, so the Memories page shows what replaced it.',
    role: 'step',
    inputs: [
      { name: 'id', type: 'text', describe: 'The id of the memory to update.', required: true },
      { name: 'text', type: 'text', describe: 'What it should say now.', required: true },
      ...WRITE_INPUTS,
    ],
    outputs: [{ name: 'memory', type: 'json', describe: 'The memory as saved.' }],
    exits: [
      { name: 'updated', describe: 'It was updated.' },
      { name: 'refused', describe: 'It could not be updated, and the output says why.' },
    ],
    settings: WRITE_SETTINGS,
    runs: 'activity',
    idempotent: false,
    summarize: () => 'updates a memory',
  }),
};

export const forgetMemory: BuiltInNode = {
  definition: defineNode({
    kind: 'forget-memory',
    title: 'Forget Memory',
    category: 'memory',
    describe: 'Retires one of the owner\'s memories that is no longer true. It is kept with why, and never recalled again.',
    role: 'step',
    inputs: [
      { name: 'id', type: 'text', describe: 'The id of the memory to forget.', required: true },
      { name: 'why', type: 'text', describe: 'Why it is no longer true.', required: true },
    ],
    outputs: [{ name: 'memory', type: 'json', describe: 'The memory as retired.' }],
    exits: [
      { name: 'forgotten', describe: 'It was retired.' },
      { name: 'refused', describe: 'It could not be retired, and the output says why.' },
    ],
    settings: { type: 'object', properties: {} },
    runs: 'activity',
    idempotent: false,
    summarize: () => 'forgets a memory',
  }),
};

export const MEMORY_NODES = [recallMemory, pointToMemories, saveMemory, updateMemory, forgetMemory];
