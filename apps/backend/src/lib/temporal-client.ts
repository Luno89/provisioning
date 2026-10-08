import { Client, Connection, type WorkflowClientInterceptor } from '@temporalio/client'
import protos from '@temporalio/proto'
import { buildDataConverter } from './temporal-codec.js'
import { OWNER_ATTRIBUTE, UnownedWorkflowError, ownerIn, startedFor } from './workflow-owner.js'
import { sharedPayloadBlobs } from './db-interface.js'
import { loadKeys } from './keys.js'

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

type OwnerResolver = (owner: string) => Promise<string>

let resolveOwner: OwnerResolver | undefined

export const resolveOwnersWith = (resolver: OwnerResolver | undefined): void => {
  resolveOwner = resolver
}

async function owned<T extends { workflowType: string; options: { workflowId: string; typedSearchAttributes?: unknown } }>(input: T): Promise<T> {
  const owner = ownerIn(input.options.typedSearchAttributes as never)
  if (!owner) throw new UnownedWorkflowError(input.workflowType, input.options.workflowId)
  const resolved = resolveOwner ? await resolveOwner(owner) : owner
  return resolved === owner ? input : { ...input, options: { ...input.options, ...startedFor(resolved) } }
}

export const requireOwner: WorkflowClientInterceptor = {
  async start(input, next) {
    return next(await owned(input))
  },
  async startWithDetails(input, next) {
    return next(await owned(input))
  },
  async signalWithStart(input, next) {
    return next(await owned(input))
  },
}

export async function registerOwnerAttribute(connection: Connection, namespace: string): Promise<void> {
  try {
    await connection.operatorService.addSearchAttributes({
      namespace,
      searchAttributes: { [OWNER_ATTRIBUTE.name]: protos.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD },
    })
  } catch (err) {
    if (!/already exists|AlreadyExists/i.test(String((err as Error)?.message ?? err))) throw err
  }
}

export async function getTemporalClient(options?: TemporalClientOptions): Promise<Client> {
  if (shared) return shared
  const address = options?.address ?? process.env.TEMPORAL_CONNECTION_ADDRESS ?? serverUrl
  const namespace = options?.namespace ?? 'default'
  const connection = await Connection.connect({ address: toConnectionAddress(address) })
  await registerOwnerAttribute(connection, namespace)
  const dataConverter = buildDataConverter(loadKeys(process.env).payload, sharedPayloadBlobs())
  shared = new Client({
    connection,
    namespace,
    interceptors: { workflow: [requireOwner] },
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
