import { keepTrying, type DependencyRefusals, type Reopening } from '../../platform/index.js';
import type { WhenPieceUp } from '../../infrastructure/index.js';
import type { GiteaService } from './GiteaService.js';

type KeepingOptions = { log?: ((message: string) => void) | undefined; again?: (() => Reopening) | undefined };

export function usersPrivateOnceGiteaIsUp(gitea: Pick<GiteaService, 'makeUsersPrivate'>, refusals: DependencyRefusals, setUp: WhenPieceUp, options: KeepingOptions = {}): void {
  setUp.whenUp('gitea', 'making every Gitea user private', () => { void keepUsersPrivate(gitea, refusals, options); });
}

export function keepUsersPrivate(
  gitea: Pick<GiteaService, 'makeUsersPrivate'>,
  refusals: DependencyRefusals,
  options: KeepingOptions = {},
): Promise<boolean> {
  const log = options.log ?? ((message: string) => console.warn(message));
  return keepTrying('[gitea] not every Gitea user is private yet', async () => {
    const changed = await gitea.makeUsersPrivate();
    if (changed.length) log(`[gitea] made ${changed.length} user(s) private: ${changed.join(', ')}`);
  }, log, (reason) => refusals.refused('gitea', `making every Gitea user private: ${reason}`), options.again?.());
}
