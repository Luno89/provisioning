import { isGrpcServiceError, type Client, type Connection, type WorkflowClientInterceptor } from '@temporalio/client'
import { connectTemporal, createClient } from '@koala/engine-core/temporal'
import protos from '@temporalio/proto'
import Long from 'long'
import { traceWorkflowStarts } from '@koala/engine-core/telemetry'
import { withProjectAttribute } from '@koala/engine-core/workflow-owner'
import { WORK_HEADER, refuseWhileDeleting, workFor, workFromHeaders, workHeader, workIsUnnamed, type ReadDeletingMarks } from '@koala/engine-core/work-for'
import type { Payload } from '@temporalio/common'
import { UnownedWorkflowError, ownerIn, startedFor } from './workflow-owner.js'
import { sharedPayloadBlobs } from './db-interface.js'
import type { PlatformKeys } from './keys.js'
import { temporalDial, type TemporalPlace } from './temporal-connection.js'
import { thrownFor, type DependencyReporter } from './dependencies.js'
import { KOALA_SEARCH_ATTRIBUTES, TEMPORAL_SYSTEM_NAMESPACE, untilTemporalSetUp } from './temporal-setup.js'
import { temporalToken } from './temporal-auth.js'

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

let deletingMarks: ReadDeletingMarks | undefined

export const refuseWorkWith = (marks: ReadDeletingMarks): void => {
  deletingMarks = marks
}

export function givenDeletingMarks(): ReadDeletingMarks {
  if (!deletingMarks) throw new Error('this process was not given where to read which projects and accounts are being removed: its entry point calls refuseWorkWith first')
  return deletingMarks
}

async function startable<T extends Parameters<typeof owned>[0] & { headers: Record<string, Payload> }>(input: T, marks: ReadDeletingMarks): Promise<T> {
  const ready = await owned(input)
  await refuseWhileDeleting(workFromHeaders(ready.headers), marks)
  return ready
}

export const requireOwner = (marks: ReadDeletingMarks): WorkflowClientInterceptor => ({
  async start(input, next) {
    return next(await startable(input, marks))
  },
  async startWithDetails(input, next) {
    return next(await startable(input, marks))
  },
  async signalWithStart(input, next) {
    return next(await startable(input, marks))
  },
})

function withItsWork<T extends { headers: Record<string, Payload>; options: { typedSearchAttributes?: Parameters<typeof ownerIn>[0] } }>(input: T): T {
  if (workIsUnnamed()) return input
  const owner = ownerIn(input.options.typedSearchAttributes)
  const project = workFor()?.project
  if (!owner && !project) return input
  const headers = { ...input.headers, [WORK_HEADER]: workHeader({ owner, project, removing: workFor()?.removing }) }
  if (!project || workFor()?.removing) return { ...input, headers }
  return { ...input, headers, options: { ...input.options, typedSearchAttributes: withProjectAttribute(input.options.typedSearchAttributes, project) } }
}

export const namesItsWork: WorkflowClientInterceptor = {
  start: (input, next) => next(withItsWork(input)),
  startWithDetails: (input, next) => next(withItsWork(input)),
  signalWithStart: (input, next) => next(withItsWork(input)),
}

const GRPC_ALREADY_EXISTS = 6

const alreadyThere = (err: unknown): boolean => isGrpcServiceError(err) && err.code === GRPC_ALREADY_EXISTS

async function madeOrThere(make: () => Promise<unknown>): Promise<void> {
  try {
    await make()
  } catch (err) {
    if (!alreadyThere(err)) throw err
  }
}

export async function registerOwnerAttribute(connection: Connection, namespace: string, adminKey?: string): Promise<void> {
  for (const attribute of KOALA_SEARCH_ATTRIBUTES) {
    const add = () => connection.operatorService.addSearchAttributes({
      namespace,
      searchAttributes: { [attribute.name]: protos.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD },
    })
    await madeOrThere(() => (adminKey ? connection.withApiKey(adminKey, add) : add()))
  }
}

const NAMESPACE_RETENTION_SECONDS = 86_400

export interface NamespaceKeys {
  system: string
  namespace: string
}

export async function readyNamespace(connection: Connection, namespace: string, keys?: NamespaceKeys): Promise<void> {
  const register = () => connection.workflowService.registerNamespace({
    namespace,
    workflowExecutionRetentionPeriod: { seconds: Long.fromNumber(NAMESPACE_RETENTION_SECONDS) },
  })
  await madeOrThere(() => (keys ? connection.withApiKey(keys.system, register) : register()))
  await registerOwnerAttribute(connection, namespace, keys?.namespace)
}

export async function setUpTemporal(connection: Connection, namespace: string, key: string, subject: string, say: (line: string) => void): Promise<void> {
  await readyNamespace(connection, namespace, {
    system: temporalToken(key, { subject, namespace: TEMPORAL_SYSTEM_NAMESPACE, role: 'admin' }),
    namespace: temporalToken(key, { subject, namespace, role: 'admin' }),
  })
  await untilTemporalSetUp(connection, namespace, say)
}

export async function getTemporalClient(): Promise<Client> {
  if (shared) return shared
  if (!given) throw new Error('this process was not given Temporal\'s settings: its entry point calls connectTemporalAs with them first')
  const marks = givenDeletingMarks()
  const { temporal, keys } = given
  const connection = await connectTemporal(temporalDial('koala-backend', given), 'client').catch((err: unknown) => {
    throw thrownFor(reporter, 'temporal', err)
  })
  await untilTemporalSetUp(connection, temporal.namespace, (line) => console.warn(`[temporal] ${line}`)).catch(async (err: unknown) => {
    await connection.close()
    throw thrownFor(reporter, 'temporal', err)
  })
  reporter?.answered('temporal')
  shared = createClient({
    connection,
    namespace: temporal.namespace,
    interceptors: { workflow: [namesItsWork, requireOwner(marks), traceWorkflowStarts()] },
    payloads: { ring: keys.payload, blobs: sharedPayloadBlobs() },
  })
  return shared
}
