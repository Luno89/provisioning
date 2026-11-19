import type { PersonaRecord } from '@koala/agent-engine';
import { PROVISION_AGENT, PROVISION_PROCEDURE } from './names.js';

export const PROVISION_PERSONAS: PersonaRecord[] = [
  {
    slug: PROVISION_AGENT,
    name: 'Set Koala up',
    description: 'Sets up a Koala\'s platform services and monitoring after its chart, or another machine\'s collector',
    version: '1',
    guidance: 'Started by the platform on every new chart revision, when a piece is found missing, and when the person asks to set Koala up again. It runs no model.',
    returns: 'Whether every piece is up, or which piece can never come up and why.',
    failures: [{ when: 'a piece can never come up', says: 'which piece and why, from its workloads; nothing after it is set up' }],
    procedure: PROVISION_PROCEDURE,
    maxEffect: 'write',
    environment: {},
    interface: {
      inputs: {
        type: 'object',
        properties: {
          ownerId: { type: 'string', description: 'Whose Koala it is.' },
          recordId: { type: 'string', description: 'The setup\'s record, one per run.' },
          target: { type: 'object', description: 'The cluster set up: the Koala\'s own, or another of the person\'s machines.' },
          revision: { type: 'number', description: 'The chart revision the setup is for.' },
          reason: { type: 'string', description: 'Why it runs: a new revision, a piece found missing, or the person asked.' },
        },
        required: ['ownerId', 'recordId', 'target', 'revision', 'reason'],
      },
      outputs: ['result'],
    },
    prompt: 'You are the structure of a setup, not a thinker in it. The procedure decides every step.',
  },
];
