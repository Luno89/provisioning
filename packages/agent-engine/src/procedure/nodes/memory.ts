import { defineNode } from '../definition.js';
import type { BuiltInNode } from '../implementation.js';
import { numberOf, textOf } from './read.js';

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
    describe: 'Picks the owner\'s active memories that apply here — project ones first, then global, newest first — and renders them as a prompt section within a character budget, saying how many were left out. A memory kept for one model is picked only when the wired binding is that model.',
    role: 'value',
    inputs: [
      { name: 'binding', type: 'modelBinding', describe: 'The model the prompt is for. Nothing wired means memories kept for one model are left out.' },
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
        maxChars: { type: 'integer', title: 'Characters', minimum: 200, maximum: 50_000, default: 6000 },
      },
    },
    runs: 'activity',
    idempotent: true,
    summarize: (settings) => `recalls ${textOf(settings, 'scope', 'all')} memories, up to ${numberOf(settings, 'maxChars', 6000)} characters`,
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

export const MEMORY_NODES = [recallMemory, saveMemory, updateMemory, forgetMemory];
