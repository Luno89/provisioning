import type { ToolDefinition } from '@koala/agent-engine';

export const SECRET_TOOLS: ToolDefinition[] = [
  {
    name: 'request_secret',
    summary: 'Ask the person for a secret a project\'s deployed service needs — an API key, a password, a token — without ever seeing it',
    guidance: 'Use this when the service being built will need a credential at run time. Name it as the environment variable the code reads. The person enters the value on a card and it goes straight into the vault; the deployed service receives it as that environment variable. You never see the value, so write code that reads the variable rather than asking for it in chat, and never put a real secret in a file, a command or a message.',
    binding: 'platform',
    effect: 'propose',
    idempotent: true,
    openWorld: false,
    status: 'draft',
    returns: 'the key, its reference `secret://<project>/<KEY>`, and a status: requested (waiting for the person), provided (already in the vault) or provisioned (created automatically)',
    failures: [
      { when: 'the key is not an environment variable name', says: 'how to name it, like DATABASE_URL' },
      { when: 'the description is missing', says: 'to say what it is for and where the person can find it' },
      { when: 'the run is about no project', says: 'that a secret belongs to a project, and to name the projectId' },
      { when: 'the project is not the person\'s or does not exist', says: 'no such project' },
      { when: 'a value is sent', says: 'never to send a value, and that nothing was saved' },
    ],
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The environment variable name the service reads, upper case with underscores, like STRIPE_API_KEY.' },
        description: { type: 'string', description: 'What the secret is for and where the person can get it, shown to them on the card.' },
        projectId: { type: 'string', description: 'The project the secret belongs to. Optional when this conversation or tree is about one project.' },
      },
      required: ['key', 'description'],
    },
  },
];
