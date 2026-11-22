import { koalaInstallEnded, type KoalaInstallFollowed } from '@koala/engine-core/koala-install';
import { installUnfinished, installView } from '../../instances/lib/koala-installs.js';
import type { InstanceRecord, KoalaInstallRecord } from '../../instances/index.js';
import type { LocalAgentDeviceMetadata } from '../../platform/index.js';

export type InstallFollowing =
  | { kind: 'none' }
  | { kind: 'waiting' }
  | { kind: 'followed'; followed: KoalaInstallFollowed }
  | { kind: 'stopped'; why: string };

export const MACHINE_GONE = 'this machine is no longer on your account, so nothing is put on it';

export const FOLLOW_GONE = 'nothing is putting Koala on this machine any more; My Machines shows where your Koala is';

type Installed = InstanceRecord & { install: KoalaInstallRecord };

const timeOf = (at: string | undefined): number => (at === undefined ? Number.NaN : Date.parse(at));

const followed = (instance: Installed): InstallFollowing => ({
  kind: 'followed',
  followed: { install: installView(instance.install), ...(instance.install.state === 'ready' && instance.url ? { url: instance.url } : {}) },
});

export function installFollowing(device: LocalAgentDeviceMetadata | undefined, instances: readonly InstanceRecord[]): InstallFollowing {
  if (!device) return { kind: 'stopped', why: MACHINE_GONE };
  const mine = instances
    .filter((instance): instance is Installed => instance.install?.machineId === device.id)
    .sort((a, b) => timeOf(b.install.at) - timeOf(a.install.at));
  const unfinished = mine.find((instance) => installUnfinished(instance.install));
  if (unfinished) return followed(unfinished);
  if (device.koalaWanted) return { kind: 'waiting' };
  const joined = timeOf(device.joinedAt ?? device.createdAt);
  const ended = mine.find((instance) => timeOf(instance.install.at) >= joined);
  const refused = device.koalaRefused && timeOf(device.koalaRefused.at) >= joined ? device.koalaRefused : undefined;
  if (ended && !(refused && timeOf(refused.at) > timeOf(ended.install.at))) return followed(ended);
  if (refused) return { kind: 'stopped', why: refused.reason };
  return { kind: 'none' };
}

export const followingEnded = (following: InstallFollowing): boolean =>
  following.kind !== 'waiting' && (following.kind !== 'followed' || koalaInstallEnded(following.followed.install));
