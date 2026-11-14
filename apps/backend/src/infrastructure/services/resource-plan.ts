import { failureOf, type ClusterMetadata, type DeploymentMetadata } from '../../platform/index.js';
import { TABBYAPI_DEFAULT_MAX_SEQ_LEN } from '../lib/app-env.js';
import { planHostMemory, unsizedModel } from '../lib/host-memory-plan.js';

export interface ResourcePlanDeps {
  modelSize(model: string, revision: string | undefined, token: string | undefined): Promise<{ totalBytes: number }>;
  clusterOf(clusterId: string): Promise<Pick<ClusterMetadata, 'name' | 'capacity'> | undefined>;
}

export type ResourcePlan =
  | { applicable: false }
  | { applicable: true; unsized: string }
  | { applicable: true; memoryLimit: string; shmSize: string; cpuLimit: string; basis: string; refusal?: string; unbudgeted?: string };

export async function resourcePlanOf(dep: DeploymentMetadata, deps: ResourcePlanDeps): Promise<ResourcePlan> {
  if (dep.appType !== 'tabbyapi' || !dep.tabbyModel) return { applicable: false };

  let modelBytes: number;
  try {
    modelBytes = (await deps.modelSize(dep.tabbyModel, dep.tabbyRevision, dep.tabbyHfToken)).totalBytes;
  } catch (err) {
    return { applicable: true, unsized: unsizedModel(dep.tabbyModel, failureOf(err).reason) };
  }

  const cluster = await deps.clusterOf(dep.clusterId);
  const allocatableBytes = cluster?.capacity ? cluster.capacity.ramGb * 1024 ** 3 : undefined;
  const unbudgeted = allocatableBytes === undefined
    ? `${cluster?.name ?? dep.clusterId} has not said how much memory it has, so whether this fits there is not checked: its agent is from before machines reported their size, or it has not connected since. Once it connects with a current agent, it says.`
    : undefined;

  const plan = planHostMemory({
    modelBytes,
    gpuCount: Number(dep.tabbyGpuCount) || 1,
    maxSeqLen: Number(dep.tabbyMaxSeqLen) || TABBYAPI_DEFAULT_MAX_SEQ_LEN,
    inlineModelLoading: dep.tabbyInlineModelLoading === true,
    allocatableBytes,
  });
  return {
    applicable: true,
    memoryLimit: `${Math.ceil(plan.limitBytes / 1e9)}G`,
    shmSize: `${Math.ceil(plan.shmBytes / 1024 ** 3)}Gi`,
    cpuLimit: '10',
    basis: plan.basis,
    ...(plan.refusal ? { refusal: plan.refusal } : {}),
    ...(unbudgeted ? { unbudgeted } : {}),
  };
}
