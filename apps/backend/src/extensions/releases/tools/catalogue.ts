import type { ToolDefinition } from '@koala/agent-engine';

export const PROPOSE_RELEASE_CHANGE = 'propose_release_change';

export const RELEASE_TOOLS: ToolDefinition[] = [
  {
    name: PROPOSE_RELEASE_CHANGE,
    summary: 'Propose how a tree type\'s or a project\'s builds are released, for the person to apply on a card',
    guidance: 'Use this when the person wants their builds released differently: beside the live app with a preview they cut over (an agent like release, with the app\'s adapter, such as odoo), or by replacing the running app (release-replace, no adapter). Set it on a tree type to change every project of that type, or on one project to override its type; clear a project\'s to go back to its type\'s. describe_tree_type says how a type releases now. Nothing changes until the person applies the card.',
    binding: 'platform',
    effect: 'propose',
    idempotent: true,
    openWorld: false,
    returns: 'that it is on a card for the person, or that the same card is already waiting',
    failures: [
      { when: 'neither or both of a tree type and a project are named, or the one named does not exist', says: 'which' },
      { when: 'the agent does not release builds, or the adapter does not fit it', says: 'what would fit' },
    ],
    parameters: {
      type: 'object',
      properties: {
        treeType: { type: 'string', description: 'The tree type whose builds are released this way, by id.' },
        project: { type: 'string', description: 'Or one project, by id, to release differently from its type.' },
        agent: { type: 'string', description: 'The agent whose procedure releases a build, such as release or release-replace.' },
        app: { type: 'string', description: 'The app adapter, for an agent that releases beside the live app (odoo). Leave it out for one that replaces.' },
        clear: { type: 'boolean', description: 'Clear the setting instead: a project goes back to its type\'s, a type back to what its repository holds.' },
        why: { type: 'string', description: 'Why, shown to the person on the card.' },
      },
      required: ['why'],
    },
  },
];
