import { Client, Connection } from '@temporalio/client'
import { buildDataConverter } from './temporal-codec.js'

const serverUrl = process.env.TEMPORAL_CONNECTION_ADDRESS || 'http://localhost:7233'

function toConnectionAddress(address: string): string {
  return address.replace(/^https?:\/\//, '')
}

export interface TemporalClientOptions {
  readonly address?: string
  readonly namespace?: string
  readonly identity?: string
}

let shared: Client | undefined

export async function getTemporalClient(options?: TemporalClientOptions): Promise<Client> {
  if (shared) return shared
  const address = options?.address ?? process.env.TEMPORAL_CONNECTION_ADDRESS ?? serverUrl
  const namespace = options?.namespace ?? 'default'
  const connection = await Connection.connect({ address: toConnectionAddress(address) })
  const dataConverter = buildDataConverter(process.env.JWT_SECRET)
  shared = new Client({
    connection,
    namespace,
    ...(dataConverter ? { dataConverter } : {}),
  })
  return shared
}

export async function ensureTemporalClient(): Promise<void> {
}

export async function pollWorkflowRun(
  workflowId: string,
  namespace: string = 'default',
): Promise<any> {
  const client = await getTemporalClient()
  const handle = client.workflow.getHandle(workflowId)
  return await handle.describe()
}
