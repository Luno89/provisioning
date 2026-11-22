import { testIdentityKey } from '../../../../backend/src/platform/testing/keys'
import type { Client, WorkflowHandle, WorkflowStartOptions } from '@temporalio/client'
import type { Site } from './site'
import { CODE_KEY, SESSION_KEY } from './site'
import { outsideThisTier, type StartedWorkflow } from './outside'
import { wireAccounts } from '../../../../backend/src/accounts/wiring/accounts'
import { devicesFor } from '../../../../backend/src/accounts/routes/device'
import { AuthService } from '../../../../backend/src/accounts/services/AuthService'
import { roleFromEnv } from '../../../../backend/src/platform/lib/platform-role'

export interface FollowedTemporal {
  client: Client
  started: StartedWorkflow[]
}

export function followedTemporal(): FollowedTemporal {
  const started: StartedWorkflow[] = []
  const handle = (workflowId: string) => ({
    workflowId,
    describe: async () => {
      if (!started.some((entry) => entry.options.workflowId === workflowId)) throw new Error(`workflow ${workflowId} not found`)
      return { status: { name: 'RUNNING' } }
    },
    query: async () => [],
    result: () => new Promise<never>(() => undefined),
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

export function mountAccounts(site: Site, temporal: FollowedTemporal): void {
  const authService = new AuthService(site.db, { codeKey: CODE_KEY })
  wireAccounts({
    app: { use: (path, router) => site.api.use(path.replace(/^\/api/, ''), router) },
    role: roleFromEnv({ ROLE: 'root', ROOT_IDENTITY_KEY: testIdentityKey() }),
    db: site.db,
    temporal: () => temporal.client,
    operatorOnly: site.auth.requireOperator('manage-accounts'),
    clearSession: site.auth.clearSession,
    devices: devicesFor({ auth: site.auth, sessionKey: SESSION_KEY, authService }),
    tellInstance: () => undefined,
  })
}
