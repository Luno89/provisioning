import { failureOf, type DeploymentMetadata } from '../../platform/index.js';
import { ignore } from '@koala/engine-core/failures';
import { TABBYAPI_DEFAULT_MAX_SEQ_LEN } from '../lib/app-env.js';
import { parseQuantity, planHostMemory, unsizedModel } from '../lib/host-memory-plan.js';

export interface ResourcePlanDeps {
  modelSize(model: string, revision: string | undefined, token: string | undefined): Promise<{ totalBytes: number }>;
  nodeMemory(clusterId: string): Promise<string>;
}

export type ResourcePlan =
  | { applicable: false }
  | { applicable: true; unsized: string }
  | { applicable: true; memoryLimit: string; shmSize: string; cpuLimit: string; basis: string; refusal?: string };

export async function resourcePlanOf(dep: DeploymentMetadata, deps: ResourcePlanDeps): Promise<ResourcePlan> {
  if (dep.appType !== 'tabbyapi' || !dep.tabbyModel) return { applicable: false };

  let modelBytes: number;
  try {
    modelBytes = (await deps.modelSize(dep.tabbyModel, dep.tabbyRevision, dep.tabbyHfToken)).totalBytes;
  } catch (err) {
    return { applicable: true, unsized: unsizedModel(dep.tabbyModel, failureOf(err).reason) };
  }

  let allocatableBytes: number | undefined;
  try {
    const sizes = (await deps.nodeMemory(dep.clusterId)).trim().split(/\s+/).map((q) => parseQuantity(q))
      .filter((n): n is number => n !== undefined);
    if (sizes.length) allocatableBytes = Math.min(...sizes);
  } catch (failure) {
    ignore('without the nodes\' memory the plan has no budget to check and says so')(failure);
  }

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
  };
}
