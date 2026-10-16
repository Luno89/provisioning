import { describe, it, expect } from 'vitest';
import { countsSql, droppedCounts, snapshot, SNAPSHOT_SQL } from './postgres-compare.js';
import type { SlotCluster } from './slot-cluster.js';

const target = { clusterName: 'dev', provider: 'k3d', namespace: 'shop', release: 'shop' };
const db = { pod: 'shop-postgres-0', user: 'odoo', database: 'odoo_a' };

describe('reading a Postgres database for a release', () => {
  it('snapshots the schema of the slot\'s database through the cluster', async () => {
    const asked: string[][] = [];
    const cluster = { exec: async (_t: unknown, pod: string, command: string[]) => { asked.push([pod, ...command]); return '{"res_partner":{"id":"integer"}}\n'; } } as unknown as SlotCluster;
    expect(await snapshot(cluster, target, db)).toEqual({ res_partner: { id: 'integer' } });
    expect(asked).toEqual([['shop-postgres-0', 'psql', '-U', 'odoo', '-d', 'odoo_a', '-v', 'ON_ERROR_STOP=1', '-tAc', SNAPSHOT_SQL]]);
  });

  it('counts only what was dropped or retyped, quoting every name, in batches the database accepts', async () => {
    const columns = Array.from({ length: 45 }, (_, at) => ({ table: 'odd"table', column: `c${at}` }));
    const queries = countsSql({ tables: ["it's"], columns, retyped: [] });
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain(`'tables|it''s', (select count(*) from "it's")`);
    expect(queries[0]).toContain(`'columns|odd"table.c0', (select count("c0") from "odd""table")`);
    const cluster = { exec: async (_t: unknown, _pod: string, command: string[]) => (command.at(-1)!.includes("'tables|it''s'") ? '{"tables|it\'s": 2, "columns|odd\\"table.c0": 1}' : '{"columns|odd\\"table.c44": 0}') } as unknown as SlotCluster;
    expect(await droppedCounts(cluster, target, db, { tables: ["it's"], columns, retyped: [] })).toEqual({ tables: { "it's": 2 }, columns: { 'odd"table.c0': 1, 'odd"table.c44': 0 } });
  });

  it('says what the database answered when it is not JSON', async () => {
    const cluster = { exec: async () => 'ERROR: permission denied' } as unknown as SlotCluster;
    await expect(snapshot(cluster, target, db)).rejects.toThrow('the database odoo_a answered something that is not JSON: ERROR: permission denied');
  });
});
