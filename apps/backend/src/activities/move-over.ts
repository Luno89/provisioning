import { Readable } from 'node:stream';
import { assessWorkload, waitUntil, type WaitOptions } from '@koala/provision';
import {
  cleaned, drained, GITEA_DATA, movedNamespaceObject, MOVED_POSTGRES, MoveParts, PG_RESTORE, restoreOrder, textOf, volumePart, type AppsManifest, type KubeObject,
} from '../instances/index.js';
import { broughtOver, type InfrastructureStore } from '../infrastructure/index.js';
import type { ClusterSteps } from './cluster-steps.js';
import { untilRolledOut, type Pause } from './watched-apply.js';

export interface MoveOverDeps {
  instanceId: string;
  steps: Pick<ClusterSteps, 'access' | 'gitea'>;
  parts: (say: (line: string) => void) => Pick<MoveParts, 'part'>;
  records: Pick<InfrastructureStore, 'getMoveIn' | 'saveMoveIn'>;
  now?: () => string;
  wait?: WaitOptions;
  pause?: Pause;
}

const BUSYBOX = 'busybox:1.37';

interface Moving {
  deps: MoveOverDeps;
  parts: Pick<MoveParts, 'part'>;
  report: (line: string) => void;
}

const kubectl = ({ deps }: Moving, args: string[], input?: Readable): Promise<string> => {
  const { access } = deps.steps;
  return input ? access.pipe(access.own(), args, input) : access.kubectl(access.own(), args);
};

async function untilNone(moving: Moving, what: string, namespace: string, selector: string): Promise<void> {
  await waitUntil(what, async () => (await kubectl(moving, ['get', 'pods', '-n', namespace, '-l', selector, '-o', 'name'])).trim() === '', undefined, moving.deps.wait);
}

async function untilPodReady(moving: Moving, namespace: string, pod: string): Promise<void> {
  let last: unknown;
  await waitUntil(
    `the pod ${pod} in ${namespace} to be ready`,
    async () => {
      last = JSON.parse(await kubectl(moving, ['get', 'pod', pod, '-n', namespace, '-o', 'json']));
      const conditions = (last as { status?: { conditions?: Array<{ type?: string; status?: string }> } }).status?.conditions ?? [];
      return conditions.some((condition) => condition.type === 'Ready' && condition.status === 'True');
    },
    async () => {
      if (!last) return undefined;
      const health = assessWorkload({ items: [last] });
      return health.health === 'unhealthy' ? health.reason : undefined;
    },
    moving.deps.wait,
  );
}

const rolledOut = (moving: Moving, what: string, namespace: string): Promise<void> =>
  untilRolledOut(moving.deps.steps, { what, reach: moving.deps.steps.access.own(), namespaces: [namespace], log: moving.report }, moving.deps.pause);

async function helperOn(moving: Moving, namespace: string, helper: string, claim: string, mount: string): Promise<void> {
  await kubectl(moving, ['delete', 'pod', helper, '-n', namespace, '--ignore-not-found', '--wait=true']);
  const overrides = {
    spec: {
      containers: [{ name: helper, image: BUSYBOX, command: ['sleep', 'infinity'], stdin: true, volumeMounts: [{ name: 'volume', mountPath: mount }] }],
      volumes: [{ name: 'volume', persistentVolumeClaim: { claimName: claim } }],
    },
  };
  await kubectl(moving, ['run', helper, '-n', namespace, `--image=${BUSYBOX}`, '--restart=Never', `--overrides=${JSON.stringify(overrides)}`]);
  await untilPodReady(moving, namespace, helper);
}

async function restorePostgres(moving: Moving, name: 'gitea-db' | 'infisical-db'): Promise<void> {
  const place = MOVED_POSTGRES[name];
  await untilPodReady(moving, place.namespace, place.pod);
  await kubectl(moving, ['exec', '-i', '-n', place.namespace, place.pod, '--', 'sh', '-c', PG_RESTORE], await moving.parts.part(name));
}

async function restoreGiteaData(moving: Moving): Promise<void> {
  const { namespace, deployment, claim, path: mount } = GITEA_DATA;
  const helper = 'move-gitea-data';
  await kubectl(moving, ['scale', `deployment/${deployment}`, '-n', namespace, '--replicas=0']);
  await untilNone(moving, 'Gitea\'s pods to stop', namespace, 'app.kubernetes.io/name=gitea');
  await restorePostgres(moving, 'gitea-db');
  await helperOn(moving, namespace, helper, claim, mount);
  await kubectl(moving, ['exec', '-i', '-n', namespace, helper, '--', 'sh', '-c', drained(`find ${mount} -mindepth 1 -delete && tar xzf - -C ${mount}`)], await moving.parts.part('gitea-data'));
  await kubectl(moving, ['delete', 'pod', helper, '-n', namespace, '--wait=true']);
  await kubectl(moving, ['scale', `deployment/${deployment}`, '-n', namespace, '--replicas=1']);
  await rolledOut(moving, 'Gitea', namespace);
}

async function restoreInfisical(moving: Moving): Promise<void> {
  const { namespace, users } = MOVED_POSTGRES['infisical-db'];
  const selector = users!;
  const replicas = (await kubectl(moving, ['get', 'deployment', '-n', namespace, '-l', selector, '-o', 'jsonpath={.items[*].spec.replicas}'])).trim().split(/\s+/).map(Number).find((count) => count > 0) ?? 1;
  await kubectl(moving, ['scale', 'deployment', '-n', namespace, '-l', selector, '--replicas=0']);
  await untilNone(moving, `the pods of ${selector} to stop`, namespace, selector);
  await restorePostgres(moving, 'infisical-db');
  await kubectl(moving, ['scale', 'deployment', '-n', namespace, '-l', selector, `--replicas=${replicas}`]);
  await rolledOut(moving, 'Infisical', namespace);
}

const applyJson = (moving: Moving, objects: KubeObject[], serverSide: boolean) =>
  kubectl(moving, ['apply', ...(serverSide ? ['--server-side', '--force-conflicts'] : []), '-f', '-'], Readable.from([JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects })]));

async function restoreVolume(moving: Moving, namespace: string, claim: string): Promise<void> {
  const helper = 'koala-move-volume';
  await helperOn(moving, namespace, helper, claim, '/volume');
  await kubectl(moving, ['exec', '-i', '-n', namespace, helper, '--', 'sh', '-c', drained('find /volume -mindepth 1 -delete && tar xzf - -C /volume')], await moving.parts.part(volumePart(namespace, claim), `Copying ${namespace}'s volume ${claim}`));
  await kubectl(moving, ['delete', 'pod', helper, '-n', namespace, '--wait=true']);
}

async function restoreApps(moving: Moving): Promise<void> {
  const manifest = JSON.parse(await textOf(await moving.parts.part('apps'))) as AppsManifest;
  const pullHost = await moving.deps.steps.gitea.getRegistryHost();
  for (const entry of manifest.namespaces) {
    moving.report(`${entry.namespace}: ${entry.objects.length} objects, ${entry.volumes.length} volumes`);
    await applyJson(moving, [movedNamespaceObject(entry, moving.deps.instanceId)], false);
    const objects = restoreOrder(entry.objects.map((object) => cleaned(object, manifest.pullHost, pullHost)));
    const claims = objects.filter((object) => object.kind === 'PersistentVolumeClaim');
    if (claims.length) await applyJson(moving, claims, true);
    for (const volume of entry.volumes) await restoreVolume(moving, entry.namespace, volume.claim);
    const rest = objects.filter((object) => object.kind !== 'PersistentVolumeClaim');
    if (rest.length) await applyJson(moving, rest, true);
  }
}

export async function bringMoveOver(deps: MoveOverDeps, report: (line: string) => void): Promise<void> {
  const moveIn = await deps.records.getMoveIn();
  if (!moveIn) throw new Error('nothing was moved onto this Koala, so there is nothing to bring over');
  if (moveIn.broughtAt) {
    report(`what the move from ${moveIn.from} left was brought over at ${moveIn.broughtAt}`);
    return;
  }
  const moving: Moving = { deps, parts: deps.parts(report), report };
  await restoreGiteaData(moving);
  await restoreInfisical(moving);
  await restoreApps(moving);
  await deps.records.saveMoveIn(broughtOver(moveIn, (deps.now ?? (() => new Date().toISOString()))()));
}
