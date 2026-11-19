import { userRoom, type SocketLike } from '../../engine-host/temporal/stream-worker.js';

export const DEPLOYMENT_UPDATED = 'deployment-updated';

export function tellDeploymentChanged(io: SocketLike | undefined, ownerId: string | undefined): void {
  if (io && ownerId) io.to(userRoom(ownerId)).emit(DEPLOYMENT_UPDATED);
}
