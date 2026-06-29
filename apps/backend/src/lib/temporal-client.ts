/**
 * Temporal Client Singleton.
 *
 * Wraps a {@link Client} connection to the Temporal server at
 * TEMPORAL_CONNECTION_ADDRESS (default http://localhost:7233).
 */
import { Client } from '@temporalio/client'

const serverUrl = process.env.TEMPORAL_CONNECTION_ADDRESS || 'http://localhost:7233'

/** Options for creating the singleton client. */
export interface TemporalClientOptions {
  readonly address?: string
  readonly namespace?: string
  readonly identity?: string
}

/** The default singleton client. */
let shared: Client | undefined

/**
 * Return (and cache) the singleton {@link Client}.
 * A second call is safe but idempotent.
 */
export async function getTemporalClient(options?: TemporalClientOptions): Promise<Client> {
  if (shared) return shared
  const address = options?.address ?? process.env.TEMPORAL_CONNECTION_ADDRESS ?? serverUrl
  const namespace = options?.namespace ?? 'default'
  shared = new Client({
    connectionAddress: address,
  })
  return shared
}

/** Return the singleton asynchronously (no-op placeholder). */
export async function ensureTemporalClient(): Promise<void> {
  // no-op; the caller should use {@link getTemporalClient}
}

/**
 * Poll a workflow run in { workflowId, namespace }.
 *
 * Returns a {@link Run} whose status indicates:
 *   - `running`       — the Workflow is still executing
 *   - `completed`     — the Workflow finished normally
 *   - `terminated`    — the Workflow was terminated
 *   - `cancelled`     — the Workflow was cancelled
 *   - `failed`        — the Workflow threw an error
 */
export async function pollWorkflowRun(
  workflowId: string,
  namespace: string = 'default',
): Promise<R> {
  const nsKey = namespace ?? 'default'
  const handle = await getTemporalClient().workflow.getHandle(workflowId, { namespace: nsKey })
  return await handle.describe()
}
