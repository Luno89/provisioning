import { PROVISION_DONE_STAGE, PROVISION_DONE_TITLE, type PlacedKoala } from '@koala/engine-core/koala-install';
import type { Database } from '../../platform/index.js';
import { koalaInstallActivities } from '../../activities/KoalaInstallActivities.js';
import type { InstanceService, PlacingMachine } from '../services/InstanceService.js';

export async function koalaPlacedAndUp(service: InstanceService, db: Pick<Database, 'instances'>, ownerId: string, machine: PlacingMachine & { meshIp: string }, name: string): Promise<PlacedKoala> {
  const installId = `install-${machine.id}`;
  const placing = await service.placeOn(ownerId, machine, name, installId);
  if (!placing.ok) throw new Error(placing.error);
  const placed = await service.placedKoala(installId, machine);
  if (!placed.ok) throw new Error(placed.error);
  const steps = koalaInstallActivities({ db: async () => ({ db, close: async () => undefined }), now: () => new Date() });
  await steps.KoalaInstallStageActivity({ installId, progress: { stage: 'koala', title: 'Putting Koala on this machine', state: 'done', url: `http://${machine.meshIp}:30320` } });
  const ended = await steps.KoalaInstallStageActivity({ installId, setup: { revision: 1, progress: { stage: PROVISION_DONE_STAGE, title: PROVISION_DONE_TITLE, state: 'done' } } });
  if (ended !== 'ready') throw new Error(`the install ended ${JSON.stringify(ended)}, not ready`);
  return placed.value;
}
