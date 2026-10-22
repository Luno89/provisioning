import { copyDatabaseScript, databaseOf, filestoreJob, helmSets, modulesIn, odooJob, splitImage, type Slot } from '../../releases/lib/odoo-release.js';
import { QUIET_PREVIEW_SQL } from '../../releases/lib/release-e2e.js';
import type { SlotAdapter, SlotBuild } from '../releases/adapter.js';
import type { ReleaseTarget, InventoryItem } from '../../releases/index.js';
import type { SlotCluster } from '../releases/slot-cluster.js';
import { query, type PostgresAccess } from '../releases/postgres-compare.js';
import { inventoryFrom, inventorySql, presentTablesSql } from './inventory.js';
import { exportCustomizations, moduleNameFor, MODEL_TABLES, takeOverSql } from './export.js';
import { ADOPT_FILE } from '../../releases/lib/customizations.js';
import { manifestVersion, moduleChanged, restoreJob, restoreJobName } from '../../releases/lib/client-import.js';

export const ODOO_ADAPTER_ID = 'odoo';

const postgres = (target: ReleaseTarget): string => `${target.release}-postgres-0`;

const access = (target: ReleaseTarget, slot: Slot): PostgresAccess => ({ pod: postgres(target), user: 'odoo', database: databaseOf(slot) });

async function installedVersions(cluster: SlotCluster, target: ReleaseTarget, slot: Slot): Promise<Map<string, string>> {
  const out = await cluster.exec(target, postgres(target), ['psql', '-U', 'odoo', '-d', databaseOf(slot), '-tAc', "select name || '|' || coalesce(latest_version, '') from ir_module_module where state = 'installed'"]).catch((err: Error) => {
    if (/does not exist/i.test(err.message)) return '';
    throw err;
  });
  return new Map(out.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => [line.split('|')[0]!, line.split('|')[1] ?? ''] as const));
}

const modules = async (cluster: SlotCluster, build: SlotBuild): Promise<string[]> => modulesIn(await cluster.files(build.source));

export const ODOO_RELEASE_ADAPTER: SlotAdapter = {
  id: ODOO_ADAPTER_ID,
  title: 'Odoo',

  workload: (target, slot) => `deployment/${target.release}-odoo-${slot}`,

  dataStore: (target) => `statefulset/${target.release}-postgres`,

  sets: ({ image, state, host, previewHost }) => helmSets({ repository: splitImage(image).repository, state, host, ...(previewHost ? { previewHost } : {}) }),

  async init(cluster, target, slot, build) {
    await cluster.job(target, `${target.release}-init-${slot}`, odooJob({
      name: '', release: target.release, image: build.image, database: databaseOf(slot), install: ['base', ...await modules(cluster, build)], update: [], vault: build.vault,
    }));
  },

  async restore(cluster, target, slot, build, mode) {
    const name = restoreJobName(target.release, slot);
    try {
      await cluster.job(target, name, restoreJob({ release: target.release, image: build.image, database: databaseOf(slot), mode, vault: build.vault }));
    } finally {
      await cluster.remove(target, 'job', name, true).catch(() => undefined);
    }
  },

  async copy(cluster, target, from, to, build) {
    await cluster.exec(target, postgres(target), ['sh', '-c', copyDatabaseScript(databaseOf(from), databaseOf(to))]);
    await cluster.job(target, `${target.release}-filestore-${to}`, filestoreJob({ name: '', release: target.release, image: build.image, from: databaseOf(from), to: databaseOf(to) }));
  },

  async quiet(cluster, target, slot) {
    await cluster.exec(target, postgres(target), ['psql', '-U', 'odoo', '-d', databaseOf(slot), '-v', 'ON_ERROR_STOP=1', '-qc', QUIET_PREVIEW_SQL]);
  },

  database: access,

  async inventory(cluster, target, slot, of) {
    const db = access(target, slot);
    const sql = inventorySql(await query<string[]>(cluster, target, db, presentTablesSql()), of);
    return sql ? inventoryFrom(await query<Partial<InventoryItem>[]>(cluster, target, db, sql)) : [];
  },

  customizationsModule: (target) => moduleNameFor(target.release),

  async exportItems(cluster, target, slot, items, module) {
    const db = access(target, slot);
    const base = (await query<string[]>(cluster, target, db, "select coalesce(json_agg(latest_version), '[]') from ir_module_module where name = 'base'"))[0] ?? '';
    const version = base.split('.').slice(0, 2).join('.') || '20.0';
    return exportCustomizations({ query: (sql) => query(cluster, target, db, sql) }, items, module, version);
  },

  async upgrade(cluster, target, slot, build, options) {
    const versions = await installedVersions(cluster, target, slot);
    const present = new Set(versions.keys());
    const wanted = await modules(cluster, build);
    const series = (versions.get('base') ?? '').split('.').slice(0, 2).join('.');
    const changed = new Set<string>();
    for (const module of wanted.filter((name) => present.has(name))) {
      if (!options?.afterRestore || moduleChanged(versions.get(module), manifestVersion(await cluster.file(build.source, `addons/${module}/__manifest__.py`)), series)) changed.add(module);
    }
    for (const module of wanted.filter((name) => !present.has(name))) {
      const adopt = await cluster.file(build.source, `addons/${module}/${ADOPT_FILE}`);
      if (!adopt) continue;
      for (const sql of takeOverSql(module, JSON.parse(adopt) as Record<string, { model: string; res_id: number }>, MODEL_TABLES)) {
        await cluster.exec(target, postgres(target), ['psql', '-U', 'odoo', '-d', databaseOf(slot), '-v', 'ON_ERROR_STOP=1', '-qc', sql]);
      }
    }
    await cluster.job(target, `${target.release}-upgrade-${slot}`, odooJob({
      name: '', release: target.release, image: build.image, database: databaseOf(slot),
      install: wanted.filter((module) => !present.has(module)),
      update: wanted.filter((module) => changed.has(module)),
      vault: build.vault,
    }));
  },
};
