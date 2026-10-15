import type { ReleaseVault, Slot, SlotState } from '../../lib/odoo-release.js';
import type { ReleaseSource, ReleaseTarget } from '../../lib/release-run.js';
import type { SlotCluster } from './slot-cluster.js';

export interface SlotBuild {
  image: string;
  source: ReleaseSource;
  vault?: ReleaseVault | undefined;
}

export interface SlotAdapter {
  id: string;
  title: string;
  workload(target: ReleaseTarget, slot: Slot): string;
  dataStore(target: ReleaseTarget): string;
  sets(input: { image: string; state: SlotState; host: string; previewHost?: string | undefined }): string[];
  init(cluster: SlotCluster, target: ReleaseTarget, slot: Slot, build: SlotBuild): Promise<void>;
  copy(cluster: SlotCluster, target: ReleaseTarget, from: Slot, to: Slot, build: SlotBuild): Promise<void>;
  quiet(cluster: SlotCluster, target: ReleaseTarget, slot: Slot): Promise<void>;
  upgrade(cluster: SlotCluster, target: ReleaseTarget, slot: Slot, build: SlotBuild): Promise<void>;
}

export type SlotAdapters = Readonly<Record<string, SlotAdapter>>;

export function adapterOf(adapters: SlotAdapters, id: unknown): SlotAdapter {
  const adapter = typeof id === 'string' ? adapters[id] : undefined;
  if (!adapter) throw new Error(`there is no release adapter called ${String(id)} (there are ${Object.keys(adapters).join(', ') || 'none'})`);
  return adapter;
}
