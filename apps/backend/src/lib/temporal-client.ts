/**
 * Temporal Client Singleton.
 *
 * Wraps a {@link Client} connection to the Temporal server at
 * TEMPORAL_CONNECTION_ADDRESS (default http://localhost:7233).
 */
import { Client, Connection } from '@temporalio/client'

const serverUrl = process.env.TEMPORAL_CONNECTION_ADDRESS || 'http://localhost:7233'

/**
 * Connection.connect wants a bare `host:port`, but this module's default (and older env values)
 * carry an `http://` scheme. Strip it rather than fail to connect on a value that has always
 * "worked" — it only ever worked because the address was being ignored entirely.
 */
function toConnectionAddress(address: string): string {
  return address.replace(/^https?:\/\//, '')
}

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
  // `connectionAddress` is not a ClientOptions key — it was silently ignored, so every client
  // connected to the SDK's default localhost:7233 and TEMPORAL_CONNECTION_ADDRESS had no effect.
  // The address has to go through an explicit Connection.
  const connection = await Connection.connect({ address: toConnectionAddress(address) })
  shared = new Client({
    connection,
    namespace,
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
): Promise<any> {
  const client = await getTemporalClient()
  const handle = client.workflow.getHandle(workflowId)
  return await handle.describe()
}

