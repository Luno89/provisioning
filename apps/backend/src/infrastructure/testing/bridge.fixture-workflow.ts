export async function executeDestroyClusterWorkflow(): Promise<void> {
  return undefined;
}

export async function executeDestroyAppWorkflow(): Promise<{ status: string }> {
  return { status: 'destroyed' };
}

export async function executeResizeDiskWorkflow(): Promise<{ workload: string }> {
  return { workload: 'healthy' };
}

export async function executeSyncConfigWorkflow(): Promise<{ workload: string; workloadReason: string }> {
  return { workload: 'unhealthy', workloadReason: 'its pod cannot pull its image' };
}

export async function executePipelineRunWorkflow(): Promise<{ imageTag: string }> {
  return { imageTag: 'reg/bo/shop:bbb' };
}
