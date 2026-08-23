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
// One kubectl read. Short on purpose: the WAITING is durable workflow timers, not this.
export const checkWorkloadActivityMeta = { name: 'CheckWorkloadActivity', startToCloseTimeout: '2 minutes' } as const;
export const downloadModelActivityMeta = { name: 'DownloadModelActivity', startToCloseTimeout: '80 minutes' } as const;
export const runPipelineActivityMeta = { name: 'RunPipelineActivity', startToCloseTimeout: '30 minutes' } as const;
// Short: a single database write. A long timeout here would only delay noticing a stuck worker.
export const updateLeafActivityMeta = { name: 'UpdateLeafActivity', startToCloseTimeout: '1 minute' } as const;
/**
 * A leaf's own work. Retries are configured at the call site.
 *
 * ── WHY THIS IS A HEARTBEAT TIMEOUT AND A LONG WALL, NOT A SHORT WALL ──
 * It was 30 minutes with no heartbeat, which asked the wrong question: "how long may this leaf
 * WORK". A leaf may legitimately work for as long as its sandbox lives, and the sandbox lives for
 * MAX_WORKSPACE_SECONDS — 60 minutes — which is also the number the prompt quotes to the agent.
 * So a leaf still making progress at 31 minutes was killed, its pod destroyed by the activity's
 * own `finally`, and restarted from step zero with everything it had written gone.
 *
 * The question worth asking is "how long may it go SILENT", and that is `heartbeatTimeout`.
 * ExecuteLeafActivity beats on every agent step and at each post-loop phase boundary, so a gap
 * means the worker is gone rather than that the work is long. `startToCloseTimeout` stays as the
 * outer backstop, set below the pod's own deadline so the sandbox is never the thing that
 * disappears first.
 *
 * ── WHY TEN MINUTES AND NOT THREE ──
 * Sized against the longest gap that can legitimately occur between two beats, not against how
 * fast we would like to notice a dead worker. The verify step is ONE sandbox exec with a 300-second
 * timeout (ExecuteLeafActivity, `buildVerifyScript`) and nothing beats inside it; push and merge are
 * 120 seconds each. A three-second-a-turn agent is not the constraint — a five-minute test suite is.
 * Three minutes here would have killed leaves in the middle of verifying work they had finished,
 * which is the failure this whole change exists to stop, arriving through a different door.
 */
export const executeLeafActivityMeta = {
  name: 'ExecuteLeafActivity',
  startToCloseTimeout: '55 minutes',
  heartbeatTimeout: '10 minutes',
} as const;
// Both are a database read plus, for the release, a handful of signalWithStart calls. Short for the
// same reason as UpdateLeafActivity: a long timeout here only delays noticing a stuck worker.
export const checkLeafGateActivityMeta = { name: 'CheckLeafGateActivity', startToCloseTimeout: '1 minute' } as const;
export const releaseDependentsActivityMeta = { name: 'ReleaseDependentsActivity', startToCloseTimeout: '2 minutes' } as const;
// A handful of API merges, no workspace. Generous only because a big fan-out means more of them.
export const landRequestActivityMeta = { name: 'LandRequestActivity', startToCloseTimeout: '5 minutes' } as const;
// Runs an agent loop in a workspace, so it is a leaf-sized operation, not an API call.
export const resolveLandingActivityMeta = { name: 'ResolveLandingActivity', startToCloseTimeout: '30 minutes' } as const;
// Boots a workspace and runs the delivered program, which may make real network calls.
export const acceptRequestActivityMeta = { name: 'AcceptRequestActivity', startToCloseTimeout: '15 minutes' } as const;

/**
 * One planning turn against a model, no sandbox. Bounded by the same thing a chat turn is — an
 * inference pass and its tool round trips.
 */
export const replanActivityMeta = { startToCloseTimeout: '10 minutes' } as const;

/**
 * Submitting and polling a crawl are single HTTP calls; storing is a bulk write of a whole batch.
 * The WAITING is durable timers in the workflow, so none of these needs to be long.
 */
export const crawlActivityMeta = {
  startToCloseTimeout: '2 minutes',
  storeTimeout: '5 minutes',
} as const;

/**
 * A review: one model call over evidence already in the database, and no sandbox at all.
 *
 * Short, because that is genuinely all it does — and because a judge that has not answered in five
 * minutes has stopped being cheaper than not having one. Its own retry policy at the call site is
 * `maximumAttempts: 1`; nothing waits on the answer, so a slow endpoint should cost one timeout
 * rather than three.
 */
export const judgeLeafActivityMeta = { name: 'JudgeLeafActivity', startToCloseTimeout: '5 minutes' } as const;
