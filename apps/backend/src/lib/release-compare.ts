export type SchemaSnapshot = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface ColumnRef {
  table: string;
  column: string;
}

export interface SchemaDiff {
  tables: string[];
  columns: ColumnRef[];
  retyped: (ColumnRef & { from: string; to: string; keptIn?: string | undefined })[];
}

export interface DroppedTable {
  table: string;
  rows: number;
}

export interface DroppedColumn extends ColumnRef {
  filled: number;
}

export interface RetypedColumn extends ColumnRef {
  from: string;
  to: string;
  filled: number;
  keptIn?: string | undefined;
}

export interface StoredField {
  model: string;
  field: string;
  table: string;
  column: string;
}

export interface RemovedField extends StoredField {
  filled: number;
}

export type ItemState = 'kept' | 'reset' | 'switched-off' | 'gone';

export interface InventoryItem {
  kind: string;
  key: string;
  name: string;
  fingerprint: string;
  active: boolean;
}

export interface ItemChange {
  kind: string;
  key: string;
  name: string;
  state: ItemState;
}

export interface ReleaseChanges {
  checkedAt: string;
  tables: DroppedTable[];
  columns: DroppedColumn[];
  retyped: RetypedColumn[];
  removedFields?: RemovedField[] | undefined;
  items: ItemChange[];
  losing: boolean;
  lost: string[];
}

export interface DroppedCounts {
  tables: Readonly<Record<string, number>>;
  columns: Readonly<Record<string, number>>;
}

const MOVED = /^(.+)_moved\d+$/;

export const columnKey = (ref: ColumnRef): string => `${ref.table}.${ref.column}`;

export function schemaChanges(live: SchemaSnapshot, preview: SchemaSnapshot): SchemaDiff {
  const tables = Object.keys(live).filter((table) => !preview[table]).sort();
  const columns: ColumnRef[] = [];
  const retyped: SchemaDiff['retyped'] = [];
  for (const [table, before] of Object.entries(live)) {
    const after = preview[table];
    if (!after) continue;
    const moved = new Map<string, string>();
    for (const column of Object.keys(after)) {
      const original = MOVED.exec(column)?.[1];
      if (original && !before[column] && before[original]) moved.set(original, column);
    }
    for (const [column, type] of Object.entries(before)) {
      if (!(column in after)) columns.push({ table, column });
      else if (after[column] !== type || moved.has(column)) retyped.push({ table, column, from: type, to: after[column]!, ...(moved.has(column) ? { keptIn: moved.get(column) } : {}) });
    }
  }
  const order = (a: ColumnRef, b: ColumnRef) => columnKey(a).localeCompare(columnKey(b));
  return { tables, columns: columns.sort(order), retyped: retyped.sort(order) };
}

export function removedFields(live: readonly StoredField[], preview: readonly StoredField[], schemas: { live: SchemaSnapshot; preview: SchemaSnapshot }): StoredField[] {
  const kept = new Set(preview.map((entry) => `${entry.model}.${entry.field}`));
  return live
    .filter((entry) => !kept.has(`${entry.model}.${entry.field}`))
    .filter((entry) => Boolean(schemas.live[entry.table]?.[entry.column]) && Boolean(schemas.preview[entry.table]?.[entry.column]))
    .sort((a, b) => `${a.model}.${a.field}`.localeCompare(`${b.model}.${b.field}`));
}

export function itemChanges(live: readonly InventoryItem[], preview: readonly InventoryItem[]): ItemChange[] {
  const after = new Map(preview.map((item) => [`${item.kind}:${item.key}`, item]));
  return live.map((item) => {
    const now = after.get(`${item.kind}:${item.key}`);
    const state: ItemState = !now ? 'gone' : item.active && !now.active ? 'switched-off' : now.fingerprint !== item.fingerprint ? 'reset' : 'kept';
    return { kind: item.kind, key: item.key, name: item.name, state };
  });
}

export function releaseChanges(diff: SchemaDiff, counts: DroppedCounts, items: readonly ItemChange[], checkedAt: string, fields: readonly StoredField[] = []): ReleaseChanges {
  const tables = diff.tables.map((table) => ({ table, rows: counts.tables[table] ?? 0 }));
  const columns = diff.columns.map((ref) => ({ ...ref, filled: counts.columns[columnKey(ref)] ?? 0 }));
  const retyped = diff.retyped.map((ref) => ({ ...ref, filled: counts.columns[columnKey(ref)] ?? 0 }));
  const removed = fields.map((entry) => ({ ...entry, filled: counts.columns[columnKey(entry)] ?? 0 }));
  const losing = tables.some((entry) => entry.rows > 0)
    || columns.some((entry) => entry.filled > 0)
    || retyped.some((entry) => entry.filled > 0)
    || removed.some((entry) => entry.filled > 0)
    || items.some((item) => item.state !== 'kept');
  const changes = { checkedAt, tables, columns, retyped, ...(removed.length ? { removedFields: removed } : {}), items: [...items], losing, lost: [] as string[] };
  return { ...changes, lost: lossLines(changes) };
}

const ITEM_STATES: Record<Exclude<ItemState, 'kept'>, string> = { reset: 'is reset', 'switched-off': 'is switched off', gone: 'is gone' };

const plural = (count: number, one: string): string => `${count} ${one}${count === 1 ? '' : 's'}`;

interface Loss {
  key: string;
  says: string;
}

function lossesOf(changes: ReleaseChanges): Loss[] {
  return [
    ...changes.tables.filter((entry) => entry.rows > 0).map((entry) => ({ key: `table:${entry.table}`, says: `the table ${entry.table} is dropped, with its ${plural(entry.rows, 'row')}` })),
    ...changes.columns.filter((entry) => entry.filled > 0).map((entry) => ({ key: `column:${columnKey(entry)}`, says: `the column ${columnKey(entry)} is dropped; ${plural(entry.filled, 'row')} held a value in it` })),
    ...changes.retyped.filter((entry) => entry.filled > 0).map((entry) => ({
      key: `retyped:${columnKey(entry)}`,
      says: `${columnKey(entry)} changes from ${entry.from} to ${entry.to}; ${plural(entry.filled, 'row')} held a value${entry.keptIn ? `, kept aside in ${entry.keptIn}` : ''}`,
    })),
    ...(changes.removedFields ?? []).filter((entry) => entry.filled > 0).map((entry) => ({
      key: `field:${entry.model}.${entry.field}`,
      says: `the field ${entry.model}.${entry.field} is removed; ${plural(entry.filled, 'row')} keep a value in it that the app will no longer show`,
    })),
    ...changes.items.filter((item) => item.state !== 'kept').map((item) => ({ key: `item:${item.kind}:${item.key}:${item.state}`, says: `${item.name} ${ITEM_STATES[item.state as Exclude<ItemState, 'kept'>]}` })),
  ];
}

export const lossLines = (changes: ReleaseChanges): string[] => lossesOf(changes).map((loss) => loss.says);

export function newLosses(accepted: ReleaseChanges | undefined, now: ReleaseChanges): string[] {
  const seen = new Set(accepted ? lossesOf(accepted).map((loss) => loss.key) : []);
  return lossesOf(now).filter((loss) => !seen.has(loss.key)).map((loss) => loss.says);
}

export function changesSentence(changes: ReleaseChanges | undefined): string {
  if (!changes) return '';
  const lost = lossLines(changes);
  if (lost.length) return `Cutting it over would lose ${lost.length === 1 ? 'one thing' : `${lost.length} things`}: ${lost.join('; ')}. The person confirms that loss to cut over.`;
  const kept = changes.items.length;
  return `Compared with live, it loses nothing${kept ? `, and the ${kept === 1 ? 'one thing' : `${kept} things`} made or changed in the app ${kept === 1 ? 'is' : 'are'} kept` : ''}.`;
}
