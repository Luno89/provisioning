import { defineNode } from '../definition.js';
import type { BuiltInNode } from '../implementation.js';
import { numberOf, textOf } from './read.js';

export const MEMORY_CATEGORIES = ['lessons_learned', 'environment_facts', 'prompt_guidance'] as const;

export const recallMemory: BuiltInNode = {
  definition: defineNode({
    kind: 'recall-memory',
    title: 'Recall Memory',
    category: 'memory',
    describe: 'Picks the owner\'s active memories that apply here — project ones first, then global, newest first — and renders them as a prompt section within a character budget, saying how many were left out.',
    role: 'value',
    inputs: [],
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
    describe: 'Writes something worth remembering for later runs. A project memory is refused when the run has no project, because it could never be recalled.',
    role: 'step',
    inputs: [
      { name: 'text', type: 'text', describe: 'What to remember.', required: true },
      { name: 'title', type: 'text', describe: 'A short name for it. Nothing wired means the first line of the text.' },
    ],
    outputs: [{ name: 'memory', type: 'json', describe: 'The memory as saved.' }],
    exits: [
      { name: 'saved', describe: 'It was saved.' },
      { name: 'refused', describe: 'It could not be saved, and the output says why.' },
    ],
    settings: {
      type: 'object',
      properties: {
        category: { type: 'string', title: 'Category', enum: MEMORY_CATEGORIES, default: 'lessons_learned' },
        scope: { type: 'string', title: 'Scope', enum: ['global', 'project'], default: 'global' },
      },
    },
    runs: 'activity',
    idempotent: false,
    summarize: (settings) => `saves a ${textOf(settings, 'scope', 'global')} ${textOf(settings, 'category', 'lessons_learned').replace(/_/g, ' ')} memory`,
  }),
};

export const MEMORY_NODES = [recallMemory, saveMemory];
