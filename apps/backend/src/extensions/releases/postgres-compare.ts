import { columnKey, type DroppedCounts, type SchemaDiff, type SchemaSnapshot } from '../../releases/lib/release-compare.js';
import type { ReleaseTarget } from '../../releases/lib/release-run.js';
import type { SlotCluster } from './slot-cluster.js';

export interface PostgresAccess {
  pod: string;
  user: string;
  database: string;
}

const COUNTS_PER_QUERY = 40;

export const identifier = (name: string): string => `"${name.replace(/"/g, '""')}"`;
export const literal = (text: string): string => `'${text.replace(/'/g, "''")}'`;

export const SNAPSHOT_SQL = [
  'select coalesce(json_object_agg(t, cols), \'{}\') from (',
  'select c.table_name as t, json_object_agg(c.column_name, c.data_type) as cols',
  'from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name',
  'where c.table_schema = \'public\' and t.table_type = \'BASE TABLE\' group by c.table_name) s',
].join(' ');

export function countsSql(diff: Pick<SchemaDiff, 'tables' | 'columns' | 'retyped'>): string[] {
  const asked = [
    ...diff.tables.map((table) => ({ group: 'tables', key: table, count: `(select count(*) from ${identifier(table)})` })),
    ...[...diff.columns, ...diff.retyped].map((ref) => ({ group: 'columns', key: columnKey(ref), count: `(select count(${identifier(ref.column)}) from ${identifier(ref.table)})` })),
  ];
  const queries: string[] = [];
  for (let at = 0; at < asked.length; at += COUNTS_PER_QUERY) {
    const chunk = asked.slice(at, at + COUNTS_PER_QUERY);
    const pairs = chunk.map((entry) => `${literal(`${entry.group}|${entry.key}`)}, ${entry.count}`).join(', ');
    queries.push(`select json_build_object(${pairs})`);
  }
  return queries;
}

export const psql = (db: PostgresAccess, sql: string): string[] => ['psql', '-U', db.user, '-d', db.database, '-v', 'ON_ERROR_STOP=1', '-tAc', sql];

export async function query<T>(cluster: Pick<SlotCluster, 'exec'>, target: ReleaseTarget, db: PostgresAccess, sql: string): Promise<T> {
  const out = (await cluster.exec(target, db.pod, psql(db, sql))).trim();
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new Error(`the database ${db.database} answered something that is not JSON: ${out.slice(0, 200)}`);
  }
}

export const snapshot = (cluster: Pick<SlotCluster, 'exec'>, target: ReleaseTarget, db: PostgresAccess): Promise<SchemaSnapshot> =>
  query<SchemaSnapshot>(cluster, target, db, SNAPSHOT_SQL);

export async function droppedCounts(cluster: Pick<SlotCluster, 'exec'>, target: ReleaseTarget, db: PostgresAccess, diff: SchemaDiff): Promise<DroppedCounts> {
  const tables: Record<string, number> = {};
  const columns: Record<string, number> = {};
  for (const sql of countsSql(diff)) {
    for (const [key, count] of Object.entries(await query<Record<string, number>>(cluster, target, db, sql))) {
      const [group, name] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
      (group === 'tables' ? tables : columns)[name] = Number(count);
    }
  }
  return { tables, columns };
}
