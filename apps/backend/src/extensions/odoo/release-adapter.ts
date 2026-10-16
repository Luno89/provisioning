import { copyDatabaseScript, databaseOf, filestoreJob, helmSets, modulesIn, odooJob, splitImage, type Slot } from '../../lib/odoo-release.js';
import { QUIET_PREVIEW_SQL } from '../../lib/release-e2e.js';
import type { SlotAdapter, SlotBuild } from '../releases/adapter.js';
import type { ReleaseTarget } from '../../lib/release-run.js';
import type { SlotCluster } from '../releases/slot-cluster.js';
import { query, type PostgresAccess } from '../releases/postgres-compare.js';
import type { InventoryItem } from '../../lib/release-compare.js';
import { inventoryFrom, inventorySql, presentTablesSql } from './inventory.js';
import { exportCustomizations, moduleNameFor, MODEL_TABLES, takeOverSql } from './export.js';
import { ADOPT_FILE } from '../../lib/customizations.js';

export const ODOO_ADAPTER_ID = 'odoo';

const postgres = (target: ReleaseTarget): string => `${target.release}-postgres-0`;

const access = (target: ReleaseTarget, slot: Slot): PostgresAccess => ({ pod: postgres(target), user: 'odoo', database: databaseOf(slot) });

async function installed(cluster: SlotCluster, target: ReleaseTarget, slot: Slot): Promise<Set<string>> {
  const out = await cluster.exec(target, postgres(target), ['psql', '-U', 'odoo', '-d', databaseOf(slot), '-tAc', "select name from ir_module_module where state = 'installed'"]).catch((err: Error) => {
    if (/does not exist/i.test(err.message)) return '';
    throw err;
  });
  return new Set(out.split('\n').map((line) => line.trim()).filter(Boolean));
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

  async upgrade(cluster, target, slot, build) {
    const present = await installed(cluster, target, slot);
    const wanted = await modules(cluster, build);
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
      update: wanted.filter((module) => present.has(module)),
      vault: build.vault,
    }));
  },
};
