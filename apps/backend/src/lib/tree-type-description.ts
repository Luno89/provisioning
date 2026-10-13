import { deliveryFor } from './delivery.js';
import { needsProject } from './tree-home.js';
import type { TreeTypeSecret, TreeTypeSpec } from './tree-types.js';
import type { WorkspaceImageSpec } from './workspace-image-seeds.js';

export interface TreeTypeParts {
  type: Pick<TreeTypeSpec, 'id' | 'label' | 'summary' | 'produces' | 'files' | 'doneMeans' | 'language' | 'secrets' | 'defaultBindings' | 'env' | 'egress'>;
  image?: Pick<WorkspaceImageSpec, 'summary' | 'available' | 'absent'> | undefined;
  growing?: string | undefined;
}

const section = (title: string, lines: string[]): string[] => (lines.length ? ['', title, ...lines] : []);

const FROM: Record<TreeTypeSecret['source'], string> = {
  generated: 'the platform makes a random one',
  'gitea-read-token': 'the platform mints a read-only Gitea token',
  person: 'the person enters it on a card; nobody else sees it',
};

const secretLine = (secret: TreeTypeSecret): string =>
  `- ${secret.key}: ${secret.describe} Put in the project's vault when the project is made (${FROM[secret.source]}); the app reads it as an environment variable${secret.signInAs ? `, and the person can see it to sign in as ${secret.signInAs}` : ''}.`;

export function describeTreeType({ type, image, growing }: TreeTypeParts): string {
  const delivery = deliveryFor(type);
  const project = needsProject(type, {});
  return [
    `${type.label} (${type.id}): ${type.summary}`,
    ...section('WHEN THE PLAN IS APPROVED', [project
      ? 'The tree gets a project of its own: a repository on the person\'s Gitea holding the starter below and the plan, a build webhook, and the person\'s own cluster to deploy to.'
      : 'The tree gets a repository of its own holding the starter below and the plan; it gets no project, because it produces an answer rather than a running service.']),
    ...section('WHAT THE REPOSITORY STARTS WITH', type.files.length ? type.files.map((file) => `- ${file.path}`) : ['- nothing: the work makes every file']),
    ...section('WHERE EACH LEAF IS WORKED', image
      ? [`Its own worktree in the ${type.language} workspace: ${image.summary}`, ...(image.available.length ? [`Installed: ${image.available.join(', ')}.`] : []), ...(image.absent.length ? [`Not there: ${image.absent.join(', ')}.`] : [])]
      : [`A ${type.language} workspace, which this install does not describe.`]).concat(
      (type.env ?? []).length ? [`Every leaf runs with ${(type.env ?? []).map((entry) => `${entry.name}=${entry.value}`).join(', ')}.`] : [],
      (type.egress ?? []).length ? [`It may also reach ${(type.egress ?? []).map((rule) => `${rule.cidr ?? `namespace ${rule.namespace}`}${rule.ports?.length ? ` on ${rule.ports.join(', ')}` : ''}`).join('; ')}.`] : [],
    ),
    ...section('HOW THE TREE GROWS', growing ? [growing] : []),
    ...section('WHAT HAPPENS TO WORK THAT LANDS ON MAIN', delivery.says),
    ...section('THE PLATFORM DOES THESE, SO NEVER PLAN THEM', delivery.owns.map((owned) => `- ${owned}`)),
    ...section('WHAT THE APP DEPENDS ON, SO NEVER PLAN DEPLOYING IT', (type.defaultBindings ?? []).map((service) => `- ${service}: the platform binds it into every deploy of the app with its credentials; the leaves' workspaces can reach it over the network but never see its credentials.`)),
    ...section('SECRETS THE PLATFORM PROVIDES, SO NEVER PLAN MAKING OR STORING THEM', (type.secrets ?? []).map(secretLine)),
    ...section('DONE MEANS', [type.doneMeans]),
  ].join('\n');
}
