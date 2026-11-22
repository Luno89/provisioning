import { freedLease, lockHolderGone, stateLockName, stateLockOf, type StateLock } from '../lib/terraform-state.js';
import type { ClusterAccess, Target } from './ClusterAccess.js';

export interface StateLocksDeps {
  access: Pick<ClusterAccess, 'kubectl'>;
  target: () => Target;
  here: string;
}

export class StateLocks {
  constructor(private readonly deps: StateLocksDeps) {}

  async freeLeftBehind(namespace: string, stackName: string, applyingHere: boolean): Promise<StateLock | undefined> {
    const kubectl = (args: readonly string[], input?: string) => this.deps.access.kubectl(this.deps.target(), args, input);
    const read = await kubectl(['get', 'lease', stateLockName(stackName), '-n', namespace, '--ignore-not-found', '-o', 'json']);
    if (!read.trim()) return undefined;
    const lease: unknown = JSON.parse(read);
    const lock = stateLockOf(lease);
    if (!lock?.host) return undefined;
    const holderPodThere = lock.host !== this.deps.here
      && (await kubectl(['get', 'pod', lock.host, '-n', namespace, '--ignore-not-found', '-o', 'name'])).trim() !== '';
    if (!lockHolderGone(lock, { here: this.deps.here, applyingHere, holderPodThere })) return undefined;
    await kubectl(['replace', '-f', '-'], JSON.stringify(freedLease(lease)));
    return lock;
  }
}
