import { Client, Connection, type WorkflowClientInterceptor } from '@temporalio/client'
import protos from '@temporalio/proto'
import { traceWorkflowStarts } from '@koala/engine-core/telemetry'
import { buildDataConverter } from './temporal-codec.js'
import { OWNER_ATTRIBUTE, UnownedWorkflowError, ownerIn, startedFor } from './workflow-owner.js'
import { sharedPayloadBlobs } from './db-interface.js'
import type { PlatformKeys } from './keys.js'
import { temporalApiKey, temporalToken } from './temporal-auth.js'
import { temporalTls } from './temporal-tls.js'
import type { TemporalPlace } from './temporal-connection.js'
import type { DependencyReporter } from './dependencies.js'

export interface TemporalClientSettings {
  temporal: TemporalPlace
  keys: Pick<PlatformKeys, 'temporal' | 'payload'>
}

let shared: Client | undefined
let given: TemporalClientSettings | undefined
let reporter: DependencyReporter | undefined

export function reportTemporalTo(to: DependencyReporter): void {
  reporter = to
}

export function connectTemporalAs(settings: TemporalClientSettings): void {
  given = settings
}

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

export async function getTemporalClient(): Promise<Client> {
  if (shared) return shared
  if (!given) throw new Error('this process was not given Temporal\'s settings: its entry point calls connectTemporalAs with them first')
  const { temporal, keys } = given
  const connection = await Connection.connect({
    address: temporal.address,
    tls: temporalTls(temporal),
    apiKey: temporalApiKey(keys.temporal, { subject: 'koala-backend', namespace: temporal.namespace, role: 'write' }),
  }).catch((err: unknown) => {
    reporter?.failed('temporal', err)
    throw err
  })
  reporter?.answered('temporal')
  await registerOwnerAttribute(connection, temporal.namespace, temporalToken(keys.temporal, { subject: 'koala-backend', namespace: temporal.namespace, role: 'admin' }))
  const dataConverter = buildDataConverter(keys.payload, sharedPayloadBlobs())
  shared = new Client({
    connection,
    namespace: temporal.namespace,
    interceptors: { workflow: [requireOwner, traceWorkflowStarts()] },
    ...(dataConverter ? { dataConverter } : {}),
  })
  return shared
}

export async function ensureTemporalClient(): Promise<void> {
}
