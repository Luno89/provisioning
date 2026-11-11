import { readyModel, type ModelToReady } from '../ready-model.js';

export { executeDeployAppWorkflow } from '../AppDeployWorkflow.js';

export async function readiesModel(args: ModelToReady): Promise<boolean> {
  return readyModel(args);
}
