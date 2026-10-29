import type { ToolDefinition } from '@koala/agent-engine';
import { HANDOVER_TOOL } from '../../engine/lib/run-grants.js';

export const HANDOVER_TOOLS: ToolDefinition[] = [
  {
    name: HANDOVER_TOOL,
    summary: 'Leave a handover note once this run\'s access was revoked',
    guidance: 'Only offered to a run whose access was taken away, in its last turn. Say where the work got to, what is done, what is '
      + 'half-done and what the next run should pick up, from what the run did. It is kept with the run and, when the run worked in a '
      + 'workspace, written there as handover/<run>.md.',
    binding: 'platform',
    effect: 'write',
    destructive: false,
    idempotent: true,
    openWorld: false,
    returns: 'Where the note was kept.',
    failures: [{ when: 'the note is empty', says: 'that a handover needs its note' }],
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'Where the work got to, what is done and half-done, and what to pick up next.' },
      },
      required: ['note'],
    },
  },
];
