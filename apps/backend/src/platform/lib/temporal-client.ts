import { Client, Connection, type WorkflowClientInterceptor, type WorkflowExecutionDescription } from '@temporalio/client'
import protos from '@temporalio/proto'
import { traceWorkflowStarts } from '@koala/engine-core/telemetry'
import { buildDataConverter } from './temporal-codec.js'
import { OWNER_ATTRIBUTE, UnownedWorkflowError, ownerIn, startedFor } from './workflow-owner.js'
import { sharedPayloadBlobs } from './db-interface.js'
import { loadKeys } from './keys.js'
import { temporalApiKey, temporalNamespaceFrom, temporalToken } from './temporal-auth.js'
import { temporalTls } from './temporal-tls.js'

const DEFAULT_ADDRESS = 'http://localhost:7233'

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

async function owned<T extends { workflowType: string; options: { workflowId: string; typedSearchAttributes?: Parameters<typeof ownerIn>[0] } }>(input: T): Promise<T> {
  const owner = ownerIn(input.options.typedSearchAttributes)
  if (!owner) throw new UnownedWorkflowError(input.workflowType, input.options.workflowId)
  const resolved = resolveOwner ? await resolveOwner(owner) : owner
  return resolved === owner ? input : { ...input, options: { ...input.options, ...startedFor(resolved) } }
}

export const ownerNotYetMapped = (err: unknown): boolean =>
  new RegExp(`no mapping defined for search attribute ${OWNER_ATTRIBUTE.name}`, 'i').test(String((err as Error)?.message ?? err))

export async function onceOwnerMapped<T>(start: () => Promise<T>, waitMs = 1_000): Promise<T> {
  for (;;) {
    try {
      return await start()
    } catch (err) {
      if (!ownerNotYetMapped(err)) throw err
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
  }
}

export const requireOwner: WorkflowClientInterceptor = {
  async start(input, next) {
    const ready = await owned(input)
    return onceOwnerMapped(() => next(ready))
  },
  async startWithDetails(input, next) {
    const ready = await owned(input)
    return onceOwnerMapped(() => next(ready))
  },
  async signalWithStart(input, next) {
    const ready = await owned(input)
    return onceOwnerMapped(() => next(ready))
  },
}

export async function registerOwnerAttribute(connection: Connection, namespace: string, adminKey?: string): Promise<void> {
  const add = () => connection.operatorService.addSearchAttributes({
    namespace,
    searchAttributes: { [OWNER_ATTRIBUTE.name]: protos.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD },
  })
  try {
    await (adminKey ? connection.withApiKey(adminKey, add) : add())
  } catch (err) {
    if (!/already exists|AlreadyExists/i.test(String((err as Error)?.message ?? err))) throw err
  }
}

export async function getTemporalClient(options?: TemporalClientOptions): Promise<Client> {
  if (shared) return shared
  const env = process.env
  const address = options?.address ?? (env.TEMPORAL_CONNECTION_ADDRESS || DEFAULT_ADDRESS)
  const namespace = options?.namespace ?? temporalNamespaceFrom(env)
  const keys = loadKeys(env)
  const connection = await Connection.connect({
    address: toConnectionAddress(address),
    tls: temporalTls(env),
    apiKey: temporalApiKey(keys.temporal, { subject: 'koala-backend', namespace, role: 'write' }),
  })
  await registerOwnerAttribute(connection, namespace, temporalToken(keys.temporal, { subject: 'koala-backend', namespace, role: 'admin' }))
  const dataConverter = buildDataConverter(keys.payload, sharedPayloadBlobs())
  shared = new Client({
    connection,
    namespace,
    interceptors: { workflow: [requireOwner, traceWorkflowStarts()] },
    ...(dataConverter ? { dataConverter } : {}),
  })
  return shared
}

export async function ensureTemporalClient(): Promise<void> {
}

export async function pollWorkflowRun(
  workflowId: string,
  _namespace: string = 'default',
): Promise<WorkflowExecutionDescription> {
  const client = await getTemporalClient()
  const handle = client.workflow.getHandle(workflowId)
  return await handle.describe()
}
