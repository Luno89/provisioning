import { defineNode } from '../definition.js';
import { valueImplementation, type BuiltInNode } from '../implementation.js';
import { NO_SETTINGS } from '../settings-schema.js';

export const runInput: BuiltInNode = {
  definition: defineNode({
    kind: 'run-input',
    title: 'Run Input',
    category: 'input',
    describe: 'What this run was started with: the message, and any named inputs.',
    role: 'value',
    inputs: [],
    outputs: [
      { name: 'message', type: 'text', describe: 'The message the run was started with.' },
      { name: 'inputs', type: 'json', describe: 'The named inputs the run was started with.' },
    ],
    exits: [],
    settings: NO_SETTINGS,
    runs: 'workflow',
    idempotent: true,
    summarize: () => 'the message and inputs this run started with',
  }),
  implementation: valueImplementation('run-input', ({ run }) => ({
    outputs: {
      message: typeof run.inputs.message === 'string' ? run.inputs.message : '',
      inputs: run.inputs,
    },
  })),
};

export const persona: BuiltInNode = {
  definition: defineNode({
    kind: 'persona',
    title: 'Persona',
    category: 'input',
    describe: 'The persona this run is bound to: its prompt, granted tools, delegates, sampling and model.',
    role: 'value',
    inputs: [],
    outputs: [
      { name: 'persona', type: 'persona', describe: 'The whole persona record.' },
      { name: 'prompt', type: 'text', describe: 'The persona\'s own prompt, trimmed.' },
      { name: 'delegates', type: 'json', describe: 'The personas this one may delegate to.' },
    ],
    exits: [],
    settings: NO_SETTINGS,
    runs: 'activity',
    idempotent: true,
    summarize: () => 'the persona this run is bound to',
  }),
};

export const INPUT_NODES = [runInput, persona];
