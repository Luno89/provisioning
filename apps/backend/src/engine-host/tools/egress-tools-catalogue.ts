import type { ToolDefinition } from '@koala/agent-engine';

export const EGRESS_TOOLS: ToolDefinition[] = [
  {
    name: 'request_egress',
    summary: 'Ask the person to let you reach one host on the internet from your workspace — an API or a download server that is blocked',
    guidance: 'Use this when a command fails because a host outside the package registries is blocked and the work cannot be done without it. Ask for the one host, not a domain you do not need.',
    binding: 'platform',
    effect: 'propose',
    idempotent: true,
    openWorld: false,
    returns: 'that the person was asked, that it was already asked, or that the host is already granted',
    failures: [
      { when: 'the host is not a host name', says: 'so' },
      { when: 'no reason is given', says: 'to say why the work needs it' },
    ],
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'The host name, like api.stripe.com. No scheme, no path.' },
        port: { type: 'number', description: 'The port, when it is not 443.' },
        why: { type: 'string', description: 'What the work needs it for, shown to the person.' },
      },
      required: ['host', 'why'],
    },
  },
];
