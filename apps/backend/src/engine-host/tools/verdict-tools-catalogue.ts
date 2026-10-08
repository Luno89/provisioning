import type { ToolDefinition } from '@koala/agent-engine';

export const VERDICTS = ['met', 'not met', 'unproven'] as const;

export const VERDICT_TOOLS: ToolDefinition[] = [
  {
    name: 'record_verdict',
    summary: 'Give your verdict on the work you were asked to judge',
    guidance: 'Call this once, when you have decided: met when what you saw shows the expectation is met, not met when it '
      + 'shows it is not, unproven when you could not check and the evidence does not settle it. Say in reasoning what you '
      + 'checked and what settled it, and list in judged the paths of what you looked at. Then answer with the verdict in a '
      + 'sentence or two.',
    binding: 'platform',
    effect: 'write',
    destructive: false,
    idempotent: true,
    openWorld: false,
    returns: 'The verdict as recorded, and the path of the verdict document when one was written.',
    failures: [
      { when: 'the verdict is not one of met, not met or unproven', says: 'which verdicts there are' },
      { when: 'there is no reasoning', says: 'that a verdict needs its reasoning' },
    ],
    parameters: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: [...VERDICTS], description: 'met, not met or unproven.' },
        reasoning: { type: 'string', description: 'What you checked and what settled it.' },
        expected: { type: 'string', description: 'The expectation you judged against, in a sentence.' },
        judged: { type: 'array', items: { type: 'string' }, description: 'The paths of what you looked at.' },
      },
      required: ['verdict', 'reasoning'],
    },
  },
];
