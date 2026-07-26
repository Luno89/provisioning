/**
 * Plain data only — no imports, deliberately. Workflow files get bundled by Temporal's
 * webpack-based sandboxing, which can't handle Node built-ins (child_process, worker_threads,
 * fs streams, ...) — importing a VALUE from an activity file directly (e.g.
 * `import { deployAppActivityMeta } from '../activities/DeployAppActivity.js'`) pulls that
 * file's entire top-level dependency tree into the workflow bundle, since ES modules execute a
 * file's imports as soon as anything is imported from it. Confirmed live: DeployAppActivity.ts
 * imports InfrastructureService/BuilderService, which import BaseService, which imports pino,
 * which imports pino-pretty, which needs `node:stream`/`node:worker_threads` — webpack failed
 * with "UnhandledSchemeError: Reading from 'node:stream' is not handled by plugins" the moment a
 * workflow imported anything (even just a timeout string) from that chain.
 *
 * `import type { X } from '../activities/Y.js'` is fine — TypeScript erases type-only imports
 * entirely, so they never reach webpack. Only VALUE imports are the problem, which is why these
 * timeout constants live here instead of alongside each activity's implementation.
 */
export const deployAppActivityMeta = { name: 'DeployAppActivity', startToCloseTimeout: '80 minutes' } as const;
export const destroyAppActivityMeta = { name: 'DestroyAppActivity', startToCloseTimeout: '60 minutes' } as const;
export const destroyClusterActivityMeta = { name: 'DestroyClusterActivity', startToCloseTimeout: '60 minutes' } as const;
export const resizeDiskActivityMeta = { name: 'ResizeDiskActivity', startToCloseTimeout: '80 minutes' } as const;
export const provisionClusterActivityMeta = { name: 'ProvisionClusterActivity', startToCloseTimeout: '80 minutes' } as const;
export const syncConfigActivityMeta = { name: 'SyncConfigActivity', startToCloseTimeout: '80 minutes' } as const;
export const downloadModelActivityMeta = { name: 'DownloadModelActivity', startToCloseTimeout: '80 minutes' } as const;
export const runPipelineActivityMeta = { name: 'RunPipelineActivity', startToCloseTimeout: '30 minutes' } as const;
