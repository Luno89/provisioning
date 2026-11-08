import type express from 'express';
import type { Client } from '@temporalio/client';
import { claimSettingsFrom, type AccessRevocations, type Database, type RoleConfig, holdsAccounts, principalOf, type UserMetadata } from '../../platform/index.js';
import type { HubPeople, Mounts } from '../../hub/index.js';
import { AccountRemovalService, temporalRemovalWorkflows } from '../services/AccountRemovalService.js';
import { ProjectInviteLimitsService } from '../services/ProjectInviteLimitsService.js';
import { ROOT_REMOVAL_STEPS, ROOT_REMOVAL_WORKFLOW } from '../lib/account-removal.js';
import { accountRouter } from '../routes/account.js';
import type { Devices } from '../routes/device.js';
import { adminRouter } from '../routes/admin.js';

export interface AccountsWiringDeps {
  app: Mounts;
  role: RoleConfig;
  env: NodeJS.ProcessEnv;
  db: Database;
  temporal: () => Client | Promise<Client>;
  hubPeople: HubPeople | undefined;
  operatorOnly: express.RequestHandler;
  clearSession: (res: express.Response) => void;
  devices: Pick<Devices, 'confirmed'>;
  revocations?: AccessRevocations | undefined;
}

export function wireAccounts(deps: AccountsWiringDeps): void {
  const { app, role, env, db } = deps;
  if (!holdsAccounts(role)) return;
  const principalFor = (user: Pick<UserMetadata, 'id' | 'roles'>) => principalOf(user, claimSettingsFrom(role));
  const removal = new AccountRemovalService({
    store: db,
    workflows: temporalRemovalWorkflows(deps.temporal, env.POOL_TASK_QUEUE || 'host-ops-queue'),
    workflowType: ROOT_REMOVAL_WORKFLOW,
    steps: ROOT_REMOVAL_STEPS,
    instances: () => db.instances.getInstances(),
    releases: () => db.instances.getReleases(),
    watches: () => db.instances.getWatches(),
    hub: deps.hubPeople,
    principalFor,
    revocations: deps.revocations,
  });
  app.use('/api/account', accountRouter({ removal, clearSession: deps.clearSession, confirmed: (req) => deps.devices.confirmed(req, (req as unknown as { user: UserMetadata }).user) }));
  app.use('/api/admin', adminRouter({ db, operatorOnly: deps.operatorOnly, inviteLimits: new ProjectInviteLimitsService({ store: db.accounts, principalFor }), removal }));
}
