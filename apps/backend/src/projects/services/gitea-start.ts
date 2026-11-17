import { keepTrying, type Reopening } from '../../platform/index.js';
import type { GiteaService } from './GiteaService.js';

export function keepUsersPrivate(
  gitea: Pick<GiteaService, 'makeUsersPrivate'>,
  options: { log?: ((message: string) => void) | undefined; again?: (() => Reopening) | undefined } = {},
): Promise<boolean> {
  const log = options.log ?? ((message: string) => console.warn(message));
  return keepTrying('[gitea] not every Gitea user is private yet', async () => {
    const changed = await gitea.makeUsersPrivate();
    if (changed.length) log(`[gitea] made ${changed.length} user(s) private: ${changed.join(', ')}`);
  }, log, options.again?.());
}
