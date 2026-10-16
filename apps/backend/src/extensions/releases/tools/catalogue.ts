import type { ToolDefinition } from '@koala/agent-engine';

export const PROPOSE_RELEASE_CHANGE = 'propose_release_change';
export const APP_DRIFT = 'app_drift';
export const PROPOSE_ADOPT_CUSTOMIZATIONS = 'propose_adopt_customizations';
export const EXPORT_CUSTOMIZATIONS = 'export_customizations';

export const RELEASE_TOOLS: ToolDefinition[] = [
  {
    name: APP_DRIFT,
    summary: 'List what was made or changed in a project\'s live app that is not in git: fields, models, views, edited views, server actions, automations, reports, email templates',
    guidance: 'Use this when the person asks what their live app holds that the repository does not, or when a release says it would lose something made in the app. It names each item and its ref, never its content or any business data. To keep them, propose bringing them into git with propose_adopt_customizations. In a conversation about one project, project may be left out.',
    binding: 'platform',
    effect: 'read',
    idempotent: true,
    openWorld: false,
    returns: 'each item, with its kind and ref, and the module it would go into',
    failures: [{ when: 'the project is not yours, has no live app, or is not released with an app that can list this', says: 'which' }],
    parameters: { type: 'object', properties: { project: { type: 'string', description: 'The project, by id. Optional in a conversation about one project.' } } },
  },
  {
    name: PROPOSE_ADOPT_CUSTOMIZATIONS,
    summary: 'Propose bringing what was made in a project\'s live app into git, as a story on a card the person approves',
    guidance: 'Use this after app_drift, when the person wants to keep what was made in the live app. Approving the card adds a story to the project\'s tree (in its feature "Customizations from the live app") whose worker exports the items exactly into the project\'s customizations module and checks it installs; it then ships through a release, and every later release keeps them. Leave refs out to bring in everything app_drift lists. Nothing changes until the person approves.',
    binding: 'platform',
    effect: 'propose',
    idempotent: false,
    openWorld: false,
    returns: 'that the story is on a card for the person',
    failures: [
      { when: 'a ref is not among what app_drift lists, or there is nothing to bring in', says: 'which' },
      { when: 'the project has no tree to add the story to', says: 'so' },
    ],
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'The project, by id. Optional in a conversation about one project.' },
        refs: { type: 'array', items: { type: 'string' }, description: 'The items to bring in, by the refs app_drift gives. Leave out for all of them.' },
        why: { type: 'string', description: 'Why, shown on the card.' },
      },
      required: ['why'],
    },
  },
  {
    name: EXPORT_CUSTOMIZATIONS,
    summary: 'Write what was made in the live app into the project\'s customizations module, exactly as it is there',
    guidance: 'Use this when a story asks you to bring customizations made in the live app into git. It reads the items from the live app and writes addons/<project>_customizations: the manifest, one data file per kind and adopt.json, which tells the release to take the live records over instead of making them again. The files are exact copies: do not edit them. Then check the module installs with odoo-check and commit.',
    binding: 'platform',
    effect: 'write',
    destructive: false,
    idempotent: true,
    openWorld: false,
    returns: 'the files it wrote',
    failures: [
      { when: 'an item points at something with no XML id, holds a file, or is gone from the live app', says: 'which and why; nothing is written' },
      { when: 'the run has no workspace to write into', says: 'so' },
    ],
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'The project, by id. Optional in the project\'s own tree.' },
        refs: { type: 'array', items: { type: 'string' }, description: 'The items to export, by ref (from the story\'s task).' },
      },
      required: ['refs'],
    },
  },
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
