import type { PersonaRecord } from '@koala/agent-engine';
import { EXTERNAL_AGENT_TASK } from './procedures.js';

export const ANTIGRAVITY_AGENT = 'antigravity';

export const EXTERNAL_PERSONAS: PersonaRecord[] = [
  {
    slug: ANTIGRAVITY_AGENT,
    name: 'Antigravity',
    description: 'Google\'s Antigravity agent, running on the person\'s machine under their own Google sign-in, handed a task to do in the project\'s folder there',
    version: '1',
    guidance: 'Runs no model of ours. Its procedure hands the task to the machine\'s antigravity agent with this prompt and what was learned before, follows what it does, and asks the person before anything it wants permission for. It never claims, records or judges anything: whoever handed it the task checks the work.',
    returns: 'What the agent said when its turn ended.',
    failures: [
      { when: 'the run has no machine, or the machine has no antigravity agent', says: 'which' },
      { when: 'the agent is not signed in, or dies', says: 'what it printed' },
      { when: 'the person cancels the run', says: 'that its turn was cancelled' },
    ],
    procedure: EXTERNAL_AGENT_TASK.id,
    maxEffect: 'write',
    environment: { workspace: true, filesystem: true, terminal: true },
    interface: {
      inputs: {
        type: 'object',
        properties: { message: { type: 'string', description: 'The task.' } },
        required: ['message'],
      },
      outputs: ['result'],
    },
    prompt: 'You are working for Koala, a platform that builds and deploys software for a person. You are handed one task at a time in their project\'s folder. Do the task there and say plainly what you did and what you could not do. Do not commit, push or deploy unless the task says to: the platform checks your work and lands it.',
  },
];
