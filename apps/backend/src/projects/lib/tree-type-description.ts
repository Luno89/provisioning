import { deliveryFor } from './delivery.js';
import { needsProject } from './tree-home.js';
import { builtLanguage, treeLanguage, versionChoices, versionsLine, type TreeTypeSecret, type TreeTypeSpec } from './tree-types.js';
import type { WorkspaceImageSpec } from '../../engine/lib/workspace-image-seeds.js';
import { readWorkspaceFile, WORKSPACE_FILE } from '../../engine/lib/workspace-file.js';
import { E2E_RUNNER } from '../../engine/lib/e2e.js';
import { TURN_ON_BROWSER_TESTS } from '../../engine/lib/browser-tests.js';

export interface ReleaseWay {
  slug: string;
  name: string;
  description?: string | undefined;
  app?: string | undefined;
}

export interface ReleaseWays {
  own: ReleaseWay;
  others: ReleaseWay[];
  restores?: { title: string } | undefined;
}

export interface TreeTypeParts {
  type: Pick<TreeTypeSpec, 'id' | 'label' | 'summary' | 'produces' | 'files' | 'doneMeans' | 'language' | 'secrets' | 'defaultBindings' | 'env' | 'egress' | 'versions'>;
  image?: Pick<WorkspaceImageSpec, 'summary' | 'available' | 'absent'> | undefined;
  growing?: string | undefined;
  releasing?: ReleaseWays | undefined;
  canGet?: readonly { name: string; summary: string }[] | undefined;
}

const wayOf = (way: ReleaseWay): string => `the ${way.slug} agent${way.description ? ` (${way.description})` : ''}${way.app ? `, with the ${way.app} adapter` : ''}`;
const releaseField = (way: ReleaseWay): string => `release: { agent: '${way.slug}'${way.app ? `, app: '${way.app}'` : ''} }`;

export function releasingLines(ways: ReleaseWays): string[] {
  return [
    `Its own way: ${wayOf(ways.own)}. A plan that leaves release out is released this way; tell the person what that means for them in a sentence.`,
    ...(ways.others.length
      ? ['It can also be released another way, which the plan\'s tree sets when the person chooses it:', ...ways.others.map((way) => `- ${wayOf(way)}: ${releaseField(way)}.`)]
      : ['This is the only way that fits it, so there is nothing to ask the person about releasing; never set release in the plan.']),
  ];
}

export function clientStartLines(restores: { title: string }): string[] {
  return [
    `When the client already runs this app, the plan's tree sets startsFrom: 'client-database'. Approving the plan then makes the project wait: its first release holds until the person uploads the client's backup (the zip ${restores.title}'s database manager makes) on the project's Settings. That backup is restored into slot a, as a neutralized copy unless the person says it is their live system, and what was made in the client's app is listed to be brought into git.`,
    'Without startsFrom the starter goes live on its own, and the client\'s database can no longer be brought in. So ask whether the client already runs it before planning, unless the person has said.',
  ];
}

const section = (title: string, lines: string[]): string[] => (lines.length ? ['', title, ...lines] : []);

const FROM: Record<TreeTypeSecret['source'], string> = {
  generated: 'the platform makes a random one',
  'gitea-read-token': 'the platform mints a read-only Gitea token',
  person: 'the person enters it on a card; nobody else sees it',
};

const secretLine = (secret: TreeTypeSecret): string =>
  `- ${secret.key}: ${secret.describe} Put in the project's vault when the project is made (${FROM[secret.source]}); the app reads it as an environment variable${secret.signInAs ? `, and the person can see it to sign in as ${secret.signInAs}` : ''}.`;

export function describeTreeType({ type, image, growing, releasing, canGet }: TreeTypeParts): string {
  const delivery = deliveryFor(type);
  const project = needsProject(type, {});
  const language = builtLanguage(treeLanguage(type, { version: type.versions?.default }));
  return [
    `${type.label} (${type.id}): ${type.summary}`,
    ...section('VERSIONS', type.versions ? [
      `${versionsLine(versionChoices(type.versions))}. A new tree is ${type.versions.of} ${type.versions.default} unless the plan's tree sets version; the starter, the workspace and the checks all follow the tree's version, and it does not change once the tree exists.`,
      ...type.versions.choices.flatMap((choice) => [`- ${choice.version}: works in the ${choice.language} workspace.`, ...(choice.vars?.versionNotes ? choice.vars.versionNotes.split('\n').map((line) => `  ${line}`) : [])]),
    ] : []),
    ...section('WHEN THE PLAN IS APPROVED', [project
      ? 'The tree gets a project of its own: a repository on the person\'s Gitea holding the starter below and the plan, a build webhook, and the person\'s own cluster to deploy to.'
      : 'The tree gets a repository of its own holding the starter below and the plan; it gets no project, because it produces an answer rather than a running service.']),
    ...section('WHAT THE REPOSITORY STARTS WITH', type.files.length ? type.files.map((file) => `- ${file.path}`) : ['- nothing: the work makes every file']),
    ...section('WHERE EACH LEAF IS WORKED', image
      ? [`Its own worktree in the ${language} workspace${type.versions ? ` (${type.versions.of} ${type.versions.default})` : ''}: ${image.summary}`, ...(image.available.length ? [`Installed: ${image.available.join(', ')}.`] : []), ...(image.absent.length ? [`Not there: ${image.absent.join(', ')}.`] : [])]
      : [`A ${language} workspace, which this install does not describe.`]).concat(
      [browserTestsLine(type, image)],
      canGet?.length ? [`It can be given any of these with change_workspace (needs) or .koala/workspace.json: ${canGet.map((entry) => `${entry.name} (${entry.summary.replace(/\.$/, '')})`).join('; ')}.`] : [],
      (type.env ?? []).length ? [`Every leaf runs with ${(type.env ?? []).map((entry) => `${entry.name}=${entry.value}`).join(', ')}.`] : [],
      (type.egress ?? []).length ? [`It may also reach ${(type.egress ?? []).map((rule) => `${rule.cidr ?? `namespace ${rule.namespace}`}${rule.ports?.length ? ` on ${rule.ports.join(', ')}` : ''}`).join('; ')}.`] : [],
    ),
    ...section('HOW THE TREE GROWS', growing ? [growing] : []),
    ...section('WHAT HAPPENS TO WORK THAT LANDS ON MAIN', delivery.says),
    ...section('HOW IT IS RELEASED', releasing && delivery.path !== 'none' ? releasingLines(releasing) : []),
    ...section('STARTING FROM THE CLIENT\'S OWN APP', releasing?.restores && delivery.path !== 'none' ? clientStartLines(releasing.restores) : []),
    ...section('THE PLATFORM DOES THESE, SO NEVER PLAN THEM', delivery.owns.map((owned) => `- ${owned}`)),
    ...section('WHAT THE APP DEPENDS ON, SO NEVER PLAN DEPLOYING IT', (type.defaultBindings ?? []).map((service) => `- ${service}: the platform binds it into every deploy of the app with its credentials; the leaves' workspaces can reach it over the network but never see its credentials.`)),
    ...section('SECRETS THE PLATFORM PROVIDES, SO NEVER PLAN MAKING OR STORING THEM', (type.secrets ?? []).map(secretLine)),
    ...section('DONE MEANS', [type.doneMeans]),
  ].join('\n');
}

export function browserTestsLine(type: Pick<TreeTypeSpec, 'files'>, image: Pick<WorkspaceImageSpec, 'available'> | undefined): string {
  if (image?.available.includes(E2E_RUNNER)) return `Browser tests: yes. Its image has ${E2E_RUNNER}, so e2e checks and Run Browser Tests serve the app to a browser.`;
  const starter = type.files.find((file) => file.path === WORKSPACE_FILE);
  const read = starter ? readWorkspaceFile(starter.content) : undefined;
  if (read && 'file' in read && read.file.needs?.includes(E2E_RUNNER)) return `Browser tests: yes. The starter's ${WORKSPACE_FILE} turns them on, so e2e checks and Run Browser Tests serve the app with its playwright.config webServer.`;
  return `Browser tests: not built in. Before a task carries an e2e check, ${TURN_ON_BROWSER_TESTS}; or check with a command.`;
}
