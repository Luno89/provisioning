import type { HostOperation } from '@koala/agent-engine/procedure';
import { PROVISION_PIECES, type ProvisionPieceKey } from '@koala/engine-core/koala-install';

const NONE = { type: 'object', properties: {} } as const;
const REASON_OUT = { name: 'reason', type: 'text', describe: 'Why it could not, when it could not.' } as const;
const DONE = { name: 'done', describe: 'It is done.' } as const;
const FAILED = { name: 'failed', describe: 'It could not be done; the reason says why, and the setup\'s record shows it.' } as const;

export const PROVISION_SERVICES: readonly ProvisionPieceKey[] = PROVISION_PIECES.map((piece) => piece.key).filter((key) => key !== 'monitoring');

export const PROVISION_STATES_MARKED = ['up', 'failed'] as const;

export const PROVISION_OPERATIONS: readonly HostOperation[] = [
  {
    name: 'provision.open',
    title: 'Open Setup',
    group: 'Provision',
    describe: 'Records the setup this run was started for, with every piece it sets up waiting: every platform service and monitoring for the Koala\'s own cluster, only the collector for another of the person\'s machines. Kind says which.',
    inputs: [],
    outputs: [{ name: 'kind', type: 'text', describe: 'koala for the Koala\'s own cluster, machine for another of the person\'s machines.' }, REASON_OUT],
    exits: [DONE, FAILED],
    settings: NONE,
    summary: 'records the setup and its pieces',
    idempotent: true,
  },
  {
    name: 'provision.service',
    title: 'Set Up Service',
    group: 'Provision',
    describe: 'Sets up one of the Koala\'s platform services on its own cluster, applying only what is missing, and waits until it is up or can never come up. The setup\'s record shows the piece working, with what it waits on, then up or failed with why.',
    inputs: [],
    outputs: [REASON_OUT],
    exits: [DONE, FAILED],
    settings: {
      type: 'object',
      required: ['service'],
      properties: { service: { type: 'string', title: 'Service', enum: [...PROVISION_SERVICES] } },
    },
    summary: 'sets up {{service}}',
    idempotent: true,
  },
  {
    name: 'provision.monitoring',
    title: 'Set Up Monitoring',
    group: 'Provision',
    describe: 'Sets up monitoring: on the Koala\'s own cluster its metrics, logs and traces, on another of the person\'s machines the collector that sends to them. It applies only what is missing and waits until it is up or can never come up.',
    inputs: [],
    outputs: [REASON_OUT],
    exits: [DONE, FAILED],
    settings: NONE,
    summary: 'sets up monitoring',
    idempotent: true,
  },
  {
    name: 'provision.mark',
    title: 'Mark Setup',
    group: 'Provision',
    describe: 'Records how the setup ended, which the Koala card and My Machines show: up once every piece is, or failed with the reason it is handed.',
    inputs: [{ name: 'reason', type: 'text', describe: 'Why, for a setup that failed.' }],
    outputs: [REASON_OUT],
    exits: [DONE, FAILED],
    settings: {
      type: 'object',
      required: ['state'],
      properties: { state: { type: 'string', title: 'Mark it', enum: [...PROVISION_STATES_MARKED] } },
    },
    summary: 'records how the setup ended',
    idempotent: true,
  },
];
