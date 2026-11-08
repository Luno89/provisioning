import type { HostWorkerSettings } from '../platform/index.js';
import { clusterAccessFrom, type ClusterAccess } from '../infrastructure/index.js';

let given: { settings: HostWorkerSettings; access: ClusterAccess } | undefined;

export function giveHostActivities(settings: HostWorkerSettings, access: ClusterAccess): void {
  given = { settings, access };
}

export function hostSettings(): HostWorkerSettings {
  if (!given) throw new Error('the host worker\'s activities were not given its settings: worker-host.ts gives them before it takes work');
  return given.settings;
}

export function hostAccess(): ClusterAccess {
  hostSettings();
  return given!.access;
}

export const hostClusterAccess = (settings: HostWorkerSettings): ClusterAccess => clusterAccessFrom(settings.clusters, { role: settings.role.role });
