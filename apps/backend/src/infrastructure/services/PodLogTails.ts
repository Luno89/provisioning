import type { Followed } from '../../platform/index.js';
import type { ClusterAccess } from './ClusterAccess.js';

export interface PodLogTailsDeps {
  access: Pick<ClusterAccess, 'follow'>;
  say(room: string, text: string): void;
  log(message: string): void;
}

export interface PodToTail {
  resourceId: string;
  clusterId: string;
  namespace: string;
  podName: string;
}

export const podLogRoom = (resourceId: string): string => `${resourceId}-kube`;

export class PodLogTails {
  private readonly tails = new Map<string, Followed>();

  constructor(private readonly deps: PodLogTailsDeps) {}

  async tail(pod: PodToTail): Promise<void> {
    this.stop(pod.resourceId);
    const room = podLogRoom(pod.resourceId);
    const followed = await this.deps.access.follow(pod.clusterId, ['logs', '-n', pod.namespace, pod.podName, '--all-containers=true', '--tail=100', '-f'], (chunk) => this.deps.say(room, chunk)).catch((err: Error) => {
      this.deps.say(room, `the logs of ${pod.podName} could not be followed: ${err.message}`);
      throw err;
    });
    this.tails.set(pod.resourceId, followed);
    followed.ended.then((result) => {
      if (this.tails.get(pod.resourceId) !== followed) return;
      this.tails.delete(pod.resourceId);
      if (result.code !== 0) this.deps.say(room, result.stderr.trim() || `the logs of ${pod.podName} stopped (exit ${result.code})`);
    }, (err: Error) => {
      if (this.tails.get(pod.resourceId) === followed) this.tails.delete(pod.resourceId);
      this.deps.log(`[pod-logs] ${pod.resourceId}: ${err.message}`);
      this.deps.say(room, `the logs of ${pod.podName} could not be followed: ${err.message}`);
    });
  }

  stop(resourceId: string): void {
    const followed = this.tails.get(resourceId);
    if (!followed) return;
    this.tails.delete(resourceId);
    followed.stop();
  }

  following(resourceId: string): boolean {
    return this.tails.has(resourceId);
  }
}
