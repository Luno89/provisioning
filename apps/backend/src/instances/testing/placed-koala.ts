import { PROVISION_DONE_STAGE, PROVISION_DONE_TITLE, type PlacedKoala } from '@koala/engine-core/koala-install';
import type { Database } from '../../platform/index.js';
import { koalaInstallActivities } from '../../activities/KoalaInstallActivities.js';
import type { InstanceService, PlacingMachine } from '../services/InstanceService.js';

const SERVICE_TOKEN = 'service-token-of-';

export const tokenOfInstance = (instanceId: string): string => `${SERVICE_TOKEN}${instanceId}`;

export const callerOfTestTokens = async (token: string): Promise<{ clientId: string; kind: 'instance' } | undefined> =>
  (token.startsWith(SERVICE_TOKEN) ? { clientId: token.slice(SERVICE_TOKEN.length), kind: 'instance' } : undefined);

let codesMade = 0;

export const testRegistrationCode = async (instance: { id: string }): Promise<string> => `registration-code-${instance.id}-${++codesMade}`;

export const testInstanceClients = { serviceCaller: callerOfTestTokens, registrationCode: testRegistrationCode };

export async function koalaPlacedAndUp(service: InstanceService, db: Pick<Database, 'instances'>, ownerId: string, machine: PlacingMachine & { meshIp: string }, name: string): Promise<PlacedKoala & { token: string }> {
  const installId = `install-${machine.id}`;
  const placing = await service.placeOn(ownerId, machine, name, installId);
  if (!placing.ok) throw new Error(placing.error);
  const placed = await service.placedKoala(installId, machine);
  if (!placed.ok) throw new Error(placed.error);
  const steps = koalaInstallActivities({ db: async () => ({ db, close: async () => undefined }), now: () => new Date() });
  await steps.KoalaInstallStageActivity({ installId, progress: { stage: 'koala', title: 'Putting Koala on this machine', state: 'done', url: `http://${machine.meshIp}:30320` } });
  const ended = await steps.KoalaInstallStageActivity({ installId, setup: { revision: 1, progress: { stage: PROVISION_DONE_STAGE, title: PROVISION_DONE_TITLE, state: 'done' } } });
  if (ended !== 'ready') throw new Error(`the install ended ${JSON.stringify(ended)}, not ready`);
  return { ...placed.value, token: tokenOfInstance(placed.value.instanceId) };
}
