import fsp from 'fs/promises';
import { Context } from '@temporalio/activity';
import { ignore } from '@koala/engine-core/failures';
import { ALREADY_HERE, HUGGING_FACE, MODEL_DOWNLOADS, modelDownloadJob, modelJobName, type Reach } from '../infrastructure/index.js';
import { computeModelFolderName } from '../models/index.js';
import { namespacedOn, runClusterJob } from './cluster-jobs.js';
import type { ClusterSteps } from './cluster-steps.js';
import { handedReach } from './handed-reach.js';

export interface DownloadModelArgs {
  clusterId: string;
  reach?: Reach | undefined;
  image: string;
  modelRepo: string;
  revision?: string | undefined;
  hfToken?: string | undefined;
  cacheHostPath: string;
  logFile?: string | undefined;
}

export interface DownloadModelResult {
  skipped: boolean;
  modelDir: string;
}

const heartbeat = (detail: unknown): void => {
  try {
    Context.current().heartbeat(detail);
  } catch (failure) {
    ignore('outside an activity, as in a test, there is nobody to tell it still runs')(failure);
  }
};

export async function DownloadModelActivity(args: DownloadModelArgs, steps: Pick<ClusterSteps, 'access'>, endpoint: string = HUGGING_FACE): Promise<DownloadModelResult> {
  const reach = handedReach(args);
  const folder = computeModelFolderName(args.modelRepo, args.revision);
  const name = modelJobName(folder);
  const said = `${args.modelRepo}${args.revision ? `@${args.revision}` : ''}`;
  const note = (line: string) => (args.logFile ? fsp.appendFile(args.logFile, `[model-download] ${line}\n`).catch(ignore('the log only shows progress, and the download goes on without it')) : Promise.resolve());
  const cluster = namespacedOn(steps.access, reach, MODEL_DOWNLOADS);

  await steps.access.apply(reach, JSON.stringify({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: MODEL_DOWNLOADS } }));
  const tokenSecret = args.hfToken ? `${name}-token` : undefined;
  if (tokenSecret) await cluster.apply({ apiVersion: 'v1', kind: 'Secret', metadata: { name: tokenSecret, namespace: MODEL_DOWNLOADS }, type: 'Opaque', stringData: { HF_TOKEN: args.hfToken } });
  await note(`${said} is downloaded on the machine into ${args.cacheHostPath}/${folder}, by the job ${name} in ${MODEL_DOWNLOADS}`);
  try {
    await runClusterJob(cluster, { name, namespace: MODEL_DOWNLOADS, manifest: modelDownloadJob({ name, image: args.image, repo: args.modelRepo, revision: args.revision, folder, cacheHostPath: args.cacheHostPath, endpoint, tokenSecret }) }, { beat: heartbeat });
  } finally {
    if (tokenSecret) await cluster.kubectl(['delete', 'secret', tokenSecret, '--ignore-not-found']);
  }
  const logs = await cluster.kubectl(['logs', `job/${name}`, '--tail=5']);
  const skipped = logs.includes(ALREADY_HERE);
  await note(skipped ? `${said} was already on the machine` : `${said} is on the machine`);
  return { skipped, modelDir: `${args.cacheHostPath}/${folder}` };
}
