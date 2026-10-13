import { CHART_FILE, type ReleaseState } from './odoo-release.js';
import { PIPELINE_FILE } from './build-plan.js';
import type { TreeTypeSpec } from './tree-types.js';

export const RELEASE_STATES: Record<ReleaseState, string> = {
  preparing: 'the build is installed into the slot that is not live, on a copy of the live database and files: new modules installed, the rest upgraded, scheduled jobs and outgoing mail switched off on the copy',
  preview: 'it runs in that slot on its own preview address, the repository\'s e2e/ browser tests run against it signed in as a test user, and it waits for the person to cut over or discard it — a newer build takes its place',
  'cutting-over': 'the live slot goes into maintenance, the latest data is copied and upgraded once more, and live switches to the new slot',
  live: 'it serves the app; the slot it replaced is stopped with its database kept as the way back',
  'rolling-back': 'the kept slot is started and live switches back to it, exactly as it was at the cutover',
  'rolled-back': 'the release before it was brought back, and anything entered since that cutover is gone',
  discarded: 'the person turned the preview down and its slot was cleared',
  superseded: 'a newer build took its place, or a cutover replaced it',
  failed: 'preparing or cutting over broke; the live slot kept serving and the reason is on the release',
};

const ORDER: ReleaseState[] = ['preparing', 'preview', 'cutting-over', 'live', 'rolling-back', 'rolled-back', 'discarded', 'superseded', 'failed'];

export type DeliveryPath = 'chart-release' | 'image-deploy' | 'waits-for-dockerfile' | 'none';

export interface Delivery {
  path: DeliveryPath;
  says: string[];
  owns: string[];
}

const BUILD = 'Every push to main builds the repository\'s Dockerfile into an image, from exactly the commit that was pushed; a commit with no Dockerfile builds nothing.';

export function deliveryFor(type: Pick<TreeTypeSpec, 'produces' | 'files'>): Delivery {
  const paths = new Set(type.files.map((file) => file.path));
  if (type.produces === 'artefact') {
    return {
      path: 'none',
      says: ['Nothing is built, deployed or exposed: the work is the files in the tree\'s own repository, and no project is made for it.'],
      owns: [],
    };
  }
  if (paths.has(CHART_FILE)) {
    return {
      path: 'chart-release',
      says: [
        BUILD,
        `The repository's ${CHART_FILE} is released by the platform, two slots on one PostgreSQL. The first build is installed into slot a, its database created and initialised, and goes live.`,
        ...ORDER.map((state) => `${state}: ${RELEASE_STATES[state]}.`),
      ],
      owns: ['installing the app or its database', 'creating, copying or upgrading databases', 'building or pushing images', 'deploying or releasing', 'exposing the app or its preview', 'cutting over or rolling back', 'recording addresses or URLs', 'the test user the browser tests sign in as'],
    };
  }
  if (paths.has('Dockerfile') || paths.has(PIPELINE_FILE)) {
    return {
      path: 'image-deploy',
      says: [BUILD, 'Each image is deployed to the project\'s cluster as an app, replacing the one before; it is reached from outside once the person exposes it.'],
      owns: ['building or pushing images', 'deploying', 'the cluster and the app\'s namespace'],
    };
  }
  return {
    path: 'waits-for-dockerfile',
    says: [`The starter has no Dockerfile, so pushes build nothing until the work adds one (or a ${PIPELINE_FILE} naming one). From then on every push is built and deployed to the project's cluster like any service.`],
    owns: ['building, pushing and deploying, once a Dockerfile exists'],
  };
}
