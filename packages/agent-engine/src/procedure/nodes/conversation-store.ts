import { defineNode } from '../definition.js';
import type { BuiltInNode } from '../implementation.js';
import { textOf } from './read.js';

const ID_HELP = 'Which conversation, written as a template over the run\'s inputs — for example {{values.conversationId}}.';

export const loadConversation: BuiltInNode = {
  definition: defineNode({
    kind: 'load-conversation',
    title: 'Load Conversation',
    category: 'context',
    describe: 'Reads a stored conversation and hands back what was said, so a run carries on where the last one stopped rather than starting cold. Nothing stored yet means an empty history, not a failure.',
    role: 'value',
    inputs: [{ name: 'values', type: 'json', describe: 'Values the id can refer to as {{values.…}}.' }],
    outputs: [
      { name: 'messages', type: 'messages', describe: 'What was said before, oldest first.' },
      { name: 'found', type: 'json', describe: 'Whether a stored conversation was there to read.' },
    ],
    exits: [],
    settings: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', title: 'Conversation', describe: ID_HELP, default: '{{values.conversationId}}' },
      },
    },
    runs: 'activity',
    idempotent: true,
    summarize: (settings) => `reads the conversation at ${textOf(settings, 'id') || 'an id you give it'}`,
  }),
};

export const saveConversation: BuiltInNode = {
  definition: defineNode({
    kind: 'save-conversation',
    title: 'Save Conversation',
    category: 'context',
    describe: 'Appends this turn to the stored conversation: what the person asked, what the model answered, what it was thinking and which tools it called. A conversation that does not exist yet is created. A retry of the same save finds the turn already written and does not append it again. Put it in the cleanup lane and a turn that was stopped part way is still recorded, rather than vanishing.',
    role: 'step',
    inputs: [
      { name: 'values', type: 'json', describe: 'Values the id can refer to as {{values.…}}.' },
      { name: 'asked', type: 'text', describe: 'What the person said this turn.', required: true },
      { name: 'reply', type: 'reply', describe: 'The model\'s answer. A turn that was cut short hands back what it had, and that is what gets written.' },
      { name: 'results', type: 'toolResults', describe: 'What the tools it called gave back, including refusals.', many: true },
      { name: 'rounds', type: 'json', describe: 'The rounds the Conversation node accumulated, each a reply with the results its calls drew back. They carry the calls made in the middle of a multi-round turn, which the reply and results inputs, being the latest, cannot.' },
    ],
    outputs: [{ name: 'conversation', type: 'text', describe: 'The conversation that was written.' }],
    exits: [
      { name: 'saved', describe: 'The turn was appended.' },
      { name: 'failed', describe: 'It could not be written.' },
    ],
    settings: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', title: 'Conversation', describe: ID_HELP, default: '{{values.conversationId}}' },
        title: {
          type: 'string',
          title: 'Title when it is new',
          describe: 'Used only when the conversation is being created. Blank means it is named after the first thing asked.',
          default: '',
        },
      },
    },
    runs: 'activity',
    idempotent: true,
    summarize: (settings) => `appends this turn to ${textOf(settings, 'id') || 'a conversation you name'}`,
  }),
};

export const CONVERSATION_STORE_NODES = [loadConversation, saveConversation];
