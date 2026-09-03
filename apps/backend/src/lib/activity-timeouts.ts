export const deployAppActivityMeta = { name: 'DeployAppActivity', startToCloseTimeout: '80 minutes' } as const;
export const destroyAppActivityMeta = { name: 'DestroyAppActivity', startToCloseTimeout: '60 minutes' } as const;
export const destroyClusterActivityMeta = { name: 'DestroyClusterActivity', startToCloseTimeout: '60 minutes' } as const;
export const resizeDiskActivityMeta = { name: 'ResizeDiskActivity', startToCloseTimeout: '80 minutes' } as const;
export const provisionClusterActivityMeta = { name: 'ProvisionClusterActivity', startToCloseTimeout: '80 minutes' } as const;
export const syncConfigActivityMeta = { name: 'SyncConfigActivity', startToCloseTimeout: '80 minutes' } as const;
export const checkWorkloadActivityMeta = { name: 'CheckWorkloadActivity', startToCloseTimeout: '2 minutes' } as const;
export const downloadModelActivityMeta = { name: 'DownloadModelActivity', startToCloseTimeout: '80 minutes' } as const;
export const verifyGpuRuntimeActivityMeta = { name: 'VerifyGpuRuntimeActivity', startToCloseTimeout: '2 minutes' } as const;
export const runPipelineActivityMeta = { name: 'RunPipelineActivity', startToCloseTimeout: '30 minutes' } as const;
export const updateLeafActivityMeta = { name: 'UpdateLeafActivity', startToCloseTimeout: '1 minute' } as const;
export const executeLeafActivityMeta = {
  name: 'ExecuteLeafActivity',
  startToCloseTimeout: '55 minutes',
  heartbeatTimeout: '10 minutes',
} as const;

export const setupLeafWorkspaceActivityMeta = {
  name: 'SetupLeafWorkspaceActivity',
  startToCloseTimeout: '15 minutes',
} as const;

export const executeLeafWorkerRoundActivityMeta = {
  name: 'ExecuteLeafWorkerRoundActivity',
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '5 minutes',
} as const;

export const validateLeafRoundActivityMeta = {
  name: 'ValidateLeafRoundActivity',
  startToCloseTimeout: '10 minutes',
  heartbeatTimeout: '3 minutes',
} as const;

export const finalizeLeafActivityMeta = {
  name: 'FinalizeLeafActivity',
  startToCloseTimeout: '10 minutes',
} as const;

export const teardownLeafWorkspaceActivityMeta = {
  name: 'TeardownLeafWorkspaceActivity',
  startToCloseTimeout: '5 minutes',
} as const;
export const checkLeafGateActivityMeta = { name: 'CheckLeafGateActivity', startToCloseTimeout: '1 minute' } as const;
export const releaseDependentsActivityMeta = { name: 'ReleaseDependentsActivity', startToCloseTimeout: '2 minutes' } as const;
export const landRequestActivityMeta = { name: 'LandRequestActivity', startToCloseTimeout: '5 minutes' } as const;
export const resolveLandingActivityMeta = { name: 'ResolveLandingActivity', startToCloseTimeout: '30 minutes' } as const;
export const acceptRequestActivityMeta = { name: 'AcceptRequestActivity', startToCloseTimeout: '15 minutes' } as const;

export const replanActivityMeta = { startToCloseTimeout: '10 minutes' } as const;

export const planProjectActivityMeta = { startToCloseTimeout: '20 minutes' } as const;

export const crawlActivityMeta = {
  startToCloseTimeout: '2 minutes',
  storeTimeout: '5 minutes',
} as const;

export const judgeLeafActivityMeta = { name: 'JudgeLeafActivity', startToCloseTimeout: '5 minutes' } as const;
