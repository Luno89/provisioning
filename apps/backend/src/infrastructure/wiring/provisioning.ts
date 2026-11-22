import type { WorkflowClient } from '@temporalio/client';
import type { Server as SocketServer } from 'socket.io';
import { PROVISIONING_CHANGED, SETUP_AGAIN_ASKED, type ProvisionPieceKey } from '@koala/engine-core/koala-install';
import { isOff, type Database, type Off } from '../../platform/index.js';
import { engineProvisionRuns } from '../../engine-host/provision-runs.js';
import { userRoom } from '../../engine-host/temporal/stream-worker.js';
import type { RunStarter } from '../../engine-host/registries/run-starter.js';
import type { Mounts } from '../../platform/index.js';
import { PROVISION_AGENT } from '../../extensions/provision/names.js';
import { provisioningRouter } from '../routes/provisioning.js';
import { Provisioning, type ProvisionRoot } from '../services/Provisioning.js';

export interface ProvisioningWiringDeps {
  tenant: Mounts;
  db: Database;
  io: SocketServer;
  runs: Pick<RunStarter, 'start'>;
  client: () => Pick<WorkflowClient, 'getHandle'> | undefined;
  connected: () => Promise<void>;
  root: ProvisionRoot;
  up: (piece: ProvisionPieceKey) => void;
  koala: { ownerId: string; clusterId: string; revision: number } | Off;
}

export function wireProvisioning(deps: ProvisioningWiringDeps): Provisioning | Off {
  const { koala } = deps;
  if (isOff(koala)) {
    deps.tenant.use('/api/infrastructure/provisioning', provisioningRouter({ provisioning: koala }));
    return koala;
  }
  const provisioning = new Provisioning({
    store: deps.db.infrastructure,
    runs: engineProvisionRuns({ runs: deps.runs, client: deps.client, connected: deps.connected, agent: PROVISION_AGENT }),
    root: deps.root,
    koala,
    changed: (ownerId, view) => { deps.io.to(userRoom(ownerId)).emit(PROVISIONING_CHANGED, view); },
    log: (line) => console.warn(line),
    up: deps.up,
  });
  deps.tenant.use('/api/infrastructure/provisioning', provisioningRouter({ provisioning }));
  void provisioning.start().catch((err: Error) => console.error(`[provisioning] Koala could not start setting itself up for chart revision ${koala.revision}: ${err.message}`));
  return provisioning;
}

export interface RootHeard {
  hear(event: string, handler: () => void): void;
}

export function wireSetupAgain(root: RootHeard, provisioning: Pick<Provisioning, 'rootAsked'>): void {
  const check = (): void => {
    provisioning.rootAsked().catch((err: Error) => console.warn(`[provisioning] whether root asks this Koala to set itself up again could not be checked: ${err.message}; root tells it again`));
  };
  root.hear(SETUP_AGAIN_ASKED, check);
  root.hear('connect', check);
}
