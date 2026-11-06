import type { Client, WorkflowHandle, WorkflowStartOptions } from '@temporalio/client'

export function outsideThisTier<T extends object>(what: string, answers: Partial<T> = {}): T {
  return new Proxy(answers, {
    get(target, key) {
      if (key in target) return (target as Record<PropertyKey, unknown>)[key]
      if (key === 'then' || typeof key === 'symbol') return undefined
      return () => { throw new Error(`${what}.${String(key)} reaches outside this machine, which the integration tier never does`) }
    },
  }) as T
}

export interface StartedWorkflow {
  workflowType: string
  options: WorkflowStartOptions
}

export interface RecordedTemporal {
  client: Client
  started: StartedWorkflow[]
}

export function recordedTemporal(): RecordedTemporal {
  const started: StartedWorkflow[] = []
  const handle = (workflowId: string) => ({
    workflowId,
    firstExecutionRunId: `${workflowId}-run`,
    result: () => new Promise<never>(() => undefined),
    describe: () => new Promise<never>(() => undefined),
  }) as unknown as WorkflowHandle
  const workflow = {
    start: async (type: string | ((...args: never[]) => unknown), options: WorkflowStartOptions) => {
      started.push({ workflowType: typeof type === 'string' ? type : type.name, options })
      return handle(options.workflowId)
    },
    getHandle: (workflowId: string) => handle(workflowId),
  }
  return { client: outsideThisTier<Client>('Temporal', { workflow: outsideThisTier<Client['workflow']>('Temporal workflow', workflow as unknown as Partial<Client['workflow']>) }), started }
}
