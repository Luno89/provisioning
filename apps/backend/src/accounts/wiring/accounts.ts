import type express from 'express';
import { claimSettingsFrom, type Database, type RoleConfig, getTemporalClient, holdsAccounts, principalOf, servesTenants, type UserMetadata } from '../../platform/index.js';
import type { HubPeople, Mounts } from '../../hub/index.js';
import type { TemporalBridge } from '../../infrastructure/index.js';
import { AccountRemovalService, temporalRemovalWorkflows } from '../services/AccountRemovalService.js';
import { ProjectInviteLimitsService } from '../services/ProjectInviteLimitsService.js';
import { DEFAULT_ENGINE_TASK_QUEUE } from '../../engine-host/temporal/contracts.js';
import { ROOT_REMOVAL_STEPS, ROOT_REMOVAL_WORKFLOW } from '../lib/account-removal.js';
import { accountRouter } from '../routes/account.js';
import { adminRouter } from '../routes/admin.js';

export interface AccountsWiringDeps {
  app: Mounts;
  role: RoleConfig;
  env: NodeJS.ProcessEnv;
  db: Database;
  temporalBridge: Pick<TemporalBridge, 'client'>;
  hubPeople: HubPeople | undefined;
  operatorOnly: express.RequestHandler;
  clearSession: (res: express.Response) => void;
}

export function wireAccounts(deps: AccountsWiringDeps): { peopleRemoval: AccountRemovalService | undefined } {
  const { app, role, env, db } = deps;
  const principalFor = (user: Pick<UserMetadata, 'id' | 'isAdmin'>) => principalOf(user, claimSettingsFrom(role));
  const accountRemoval = servesTenants(role) ? new AccountRemovalService({
    store: db,
    workflows: temporalRemovalWorkflows(() => deps.temporalBridge.client, env.TEMPORAL_ENGINE_TASK_QUEUE || DEFAULT_ENGINE_TASK_QUEUE),
    hub: deps.hubPeople,
    principalFor,
  }) : undefined;
  const rootRemoval = holdsAccounts(role) && !servesTenants(role) ? new AccountRemovalService({
    store: db,
    workflows: temporalRemovalWorkflows(() => getTemporalClient(), env.POOL_TASK_QUEUE || 'host-ops-queue'),
    workflowType: ROOT_REMOVAL_WORKFLOW,
    steps: ROOT_REMOVAL_STEPS,
    instances: () => db.instances.getInstances(),
    releases: () => db.instances.getReleases(),
    hub: deps.hubPeople,
    principalFor,
  }) : undefined;
  const peopleRemoval = rootRemoval ?? accountRemoval;
  if (holdsAccounts(role) && peopleRemoval) app.use('/api/account', accountRouter({ removal: peopleRemoval, clearSession: deps.clearSession }));
  if (holdsAccounts(role)) app.use('/api/admin', adminRouter({ db, operatorOnly: deps.operatorOnly, inviteLimits: new ProjectInviteLimitsService({ store: db.accounts, principalFor }), ...(peopleRemoval ? { removal: peopleRemoval } : {}) }));
  return { peopleRemoval };
}
