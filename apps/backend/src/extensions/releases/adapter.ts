import type { ReleaseVault, Slot, SlotState } from '../../lib/odoo-release.js';
import type { ReleaseSource, ReleaseTarget } from '../../lib/release-run.js';
import type { InventoryItem } from '../../lib/release-compare.js';
import type { PostgresAccess } from './postgres-compare.js';
import type { ExportResult } from '../../lib/customizations.js';
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
  database(target: ReleaseTarget, slot: Slot): PostgresAccess;
  inventory?(cluster: SlotCluster, target: ReleaseTarget, slot: Slot, of?: readonly InventoryItem[]): Promise<InventoryItem[]>;
  exportItems?(cluster: SlotCluster, target: ReleaseTarget, slot: Slot, items: readonly { kind: string; key: string }[], module: string): Promise<ExportResult>;
  customizationsModule?(target: ReleaseTarget): string;
}

export type SlotAdapters = Readonly<Record<string, SlotAdapter>>;

export function adapterOf(adapters: SlotAdapters, id: unknown): SlotAdapter {
  const adapter = typeof id === 'string' ? adapters[id] : undefined;
  if (!adapter) throw new Error(`there is no release adapter called ${String(id)} (there are ${Object.keys(adapters).join(', ') || 'none'})`);
  return adapter;
}
