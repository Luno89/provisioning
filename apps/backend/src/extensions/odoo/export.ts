import { literal } from '../releases/postgres-compare.js';
import { ODOO_KINDS } from './inventory.js';
import { ADOPT_FILE, type ExportResult } from '../../releases/lib/customizations.js';

export interface FieldMeta {
  name: string;
  ttype: string;
  relation?: string | null | undefined;
  relationTable?: string | null | undefined;
  column1?: string | null | undefined;
  column2?: string | null | undefined;
}

export interface FetchedRecord {
  key: string;
  kind: string;
  model: string;
  id: number;
  row: Readonly<Record<string, unknown>>;
  fields: readonly FieldMeta[];
  many: Readonly<Record<string, readonly number[]>>;
  own?: string | undefined;
}


export type XmlIds = ReadonlyMap<string, string>;

export const refKey = (model: string, id: number): string => `${model}:${id}`;

const SKIPPED = new Set(['id', 'create_uid', 'create_date', 'write_uid', 'write_date', 'arch_fs', 'arch_prev', 'arch_updated', 'arch', 'model_data_id', 'xml_id', 'display_name']);
const NOT_EXPORTED_TYPES = new Set(['one2many']);
const MODULE_RECORDS = new Set(['__export__', '__import__', 'studio_customization']);

export const moduleNameFor = (release: string): string =>
  `${release.replace(/-[0-9a-z]{6}$/, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'project'}_customizations`;

const slug = (text: string): string => text.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase().slice(0, 60) || 'item';

const escapeText = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (text: string): string => escapeText(text).replace(/"/g, '&quot;');

const translated = (value: unknown): unknown => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = value as Record<string, unknown>;
    return entries.en_US ?? Object.values(entries)[0];
  }
  return value;
};

export function newName(record: Pick<FetchedRecord, 'kind' | 'model' | 'id' | 'row'>): string {
  const row = record.row;
  if (record.model === 'ir.model.fields') return `field_${slug(String(row.model ?? ''))}__${slug(String(row.name ?? record.id))}`;
  if (record.model === 'ir.model') return `model_${slug(String(row.model ?? record.id))}`;
  const named = translated(row.name);
  return `${slug(record.kind)}_${slug(typeof named === 'string' ? named : '')}_${record.id}`;
}

function fieldLine(record: FetchedRecord, field: FieldMeta, xmlids: XmlIds, adopted: XmlIds): string | { why: string } | undefined {
  if (SKIPPED.has(field.name) || NOT_EXPORTED_TYPES.has(field.ttype)) return undefined;
  if (record.model === 'ir.ui.view' && field.name === 'arch_db') {
    const arch = translated(record.row.arch_db);
    return typeof arch === 'string' ? `    <field name="arch" type="xml">${arch}</field>` : undefined;
  }
  if (field.ttype === 'many2many') {
    const ids = record.many[field.name] ?? [];
    if (!ids.length) return undefined;
    const refs: string[] = [];
    for (const id of ids) {
      const ref = adopted.get(refKey(field.relation ?? '', id)) ?? xmlids.get(refKey(field.relation ?? '', id));
      if (!ref) return { why: `its ${field.name} points at a ${field.relation} record (id ${id}) that has no XML id to name it by` };
      refs.push(`ref('${ref}')`);
    }
    return `    <field name="${field.name}" eval="[Command.set([${refs.join(', ')}])]"/>`;
  }
  const value = record.row[field.name];
  if (value === null || value === undefined) return undefined;
  if (field.ttype === 'many2one') {
    const ref = adopted.get(refKey(field.relation ?? '', Number(value))) ?? xmlids.get(refKey(field.relation ?? '', Number(value)));
    if (!ref) return { why: `its ${field.name} points at a ${field.relation} record (id ${String(value)}) that has no XML id to name it by` };
    return `    <field name="${field.name}" ref="${escapeAttr(ref)}"/>`;
  }
  if (field.ttype === 'binary') return { why: `its ${field.name} holds a file, which is not exported` };
  if (field.ttype === 'boolean') return `    <field name="${field.name}" eval="${value ? 'True' : 'False'}"/>`;
  if (field.ttype === 'integer' || field.ttype === 'float' || field.ttype === 'monetary') return `    <field name="${field.name}" eval="${Number(value)}"/>`;
  const text = translated(value);
  if (typeof text !== 'string') return text === undefined || text === null ? undefined : `    <field name="${field.name}">${escapeText(JSON.stringify(text))}</field>`;
  return `    <field name="${field.name}">${escapeText(text)}</field>`;
}

export function renderRecord(record: FetchedRecord, xmlids: XmlIds, adopted: XmlIds): { xml: string } | { why: string } {
  const id = record.own ?? adopted.get(refKey(record.model, record.id)) ?? newName(record);
  const fields = record.own ? record.fields.filter((field) => field.name === 'arch_db') : record.fields;
  const lines: string[] = [];
  for (const field of [...fields].sort((a, b) => a.name.localeCompare(b.name))) {
    const line = fieldLine(record, field, xmlids, adopted);
    if (line === undefined) continue;
    if (typeof line !== 'string') return line;
    lines.push(line);
  }
  return { xml: `  <record id="${escapeAttr(id)}" model="${record.model}">\n${lines.join('\n')}\n  </record>` };
}

const KIND_FILES: Record<string, string> = {
  model: 'models', field: 'fields', view: 'views', 'edited-view': 'views', 'server-action': 'actions', automation: 'automations', report: 'reports', 'email-template': 'mail_templates',
};
const KIND_DEPENDS: Record<string, string> = { automation: 'base_automation', 'email-template': 'mail' };
const FILE_ORDER = ['models', 'fields', 'views', 'actions', 'reports', 'mail_templates', 'automations'];

export function renderModule(module: string, records: readonly FetchedRecord[], xmlids: XmlIds, versionPrefix: string): ExportResult {
  const adopted = new Map(records.filter((record) => !record.own).map((record) => [refKey(record.model, record.id), `${module}.${newName(record)}`]));
  const local = new Map([...adopted].map(([key, value]) => [key, value.slice(module.length + 1)]));
  const refused: ExportResult['refused'] = [];
  const byFile = new Map<string, string[]>();
  const depends = new Set<string>(['base']);
  for (const record of records) {
    const rendered = renderRecord(record, xmlids, local);
    if ('why' in rendered) {
      refused.push({ key: record.key, why: rendered.why });
      continue;
    }
    const file = KIND_FILES[record.kind] ?? 'records';
    byFile.set(file, [...(byFile.get(file) ?? []), rendered.xml]);
    if (KIND_DEPENDS[record.kind]) depends.add(KIND_DEPENDS[record.kind]!);
    if (record.own) depends.add(record.own.split('.')[0]!);
    for (const ref of rendered.xml.matchAll(/ref(?:="|\(')([A-Za-z0-9_]+)\./g)) {
      if (ref[1] && ref[1] !== module && !MODULE_RECORDS.has(ref[1])) depends.add(ref[1]);
    }
  }
  if (refused.length) return { module, files: [], refused };
  const files = [...byFile.keys()].sort((a, b) => (FILE_ORDER.indexOf(a) + 100 * Number(!FILE_ORDER.includes(a))) - (FILE_ORDER.indexOf(b) + 100 * Number(!FILE_ORDER.includes(b))));
  const takeOver = Object.fromEntries(records.filter((record) => !record.own).map((record) => [newName(record), { model: record.model, res_id: record.id }]));
  return {
    module,
    refused: [],
    files: [
      { path: `addons/${module}/__init__.py`, content: '' },
      {
        path: `addons/${module}/__manifest__.py`,
        content: [
          '{',
          `    'name': ${JSON.stringify(module.replace(/_/g, ' '))},`,
          `    'version': '${versionPrefix}.1.0.0',`,
          `    'summary': 'What was made or changed in the live app, brought into git',`,
          `    'depends': [${[...depends].sort().map((name) => `'${name}'`).join(', ')}],`,
          `    'data': [${files.map((file) => `'data/${file}.xml'`).join(', ')}],`,
          "    'license': 'LGPL-3',",
          '}',
          '',
        ].join('\n'),
      },
      ...files.map((file) => ({ path: `addons/${module}/data/${file}.xml`, content: `<?xml version="1.0" encoding="utf-8"?>\n<odoo>\n${byFile.get(file)!.join('\n\n')}\n</odoo>\n` })),
      { path: `addons/${module}/${ADOPT_FILE}`, content: `${JSON.stringify(takeOver, null, 2)}\n` },
    ],
  };
}

export function recordSql(kind: string, key: string): string | undefined {
  const spec = ODOO_KINDS.find((entry) => entry.kind === kind);
  if (!spec) return undefined;
  return `select coalesce((select json_build_object('model', ${literal(spec.model)}, 'id', r.id, 'row', to_jsonb(r)) from ${spec.table} r where ${spec.key} = ${literal(key)} limit 1), 'null'::json)`;
}

export const fieldsSql = (model: string): string =>
  `select coalesce(json_agg(json_build_object('name', f.name, 'ttype', f.ttype, 'relation', f.relation, 'relationTable', f.relation_table, 'column1', f.column1, 'column2', f.column2) order by f.name), '[]') from ir_model_fields f where f.model = ${literal(model)} and f.store`;

export const manySql = (field: FieldMeta, id: number): string | undefined =>
  field.relationTable && field.column1 && field.column2
    ? `select coalesce(json_agg(${field.column2} order by ${field.column2}), '[]') from ${field.relationTable} where ${field.column1} = ${id}`
    : undefined;

export const ownXmlIdSql = (model: string, id: number): string =>
  `select coalesce(json_agg(module || '.' || name), '[]') from ir_model_data where model = ${literal(model)} and res_id = ${id} and module not in ('__export__', '__import__', 'studio_customization')`;

export function xmlIdsSql(wanted: readonly { model: string; id: number }[]): string | undefined {
  if (!wanted.length) return undefined;
  const pairs = wanted.map((entry) => `(${literal(entry.model)}, ${entry.id})`).join(', ');
  return `select coalesce(json_agg(json_build_object('key', d.model || ':' || d.res_id, 'xmlid', d.module || '.' || d.name) order by d.module = '__export__', d.id), '[]') from ir_model_data d where (d.model, d.res_id) in (${pairs})`;
}

export function referencesOf(record: Pick<FetchedRecord, 'row' | 'fields' | 'many'>): { model: string; id: number }[] {
  const wanted: { model: string; id: number }[] = [];
  for (const field of record.fields) {
    if (!field.relation) continue;
    if (field.ttype === 'many2one' && record.row[field.name] !== null && record.row[field.name] !== undefined) wanted.push({ model: field.relation, id: Number(record.row[field.name]) });
    if (field.ttype === 'many2many') for (const id of record.many[field.name] ?? []) wanted.push({ model: field.relation, id });
  }
  return wanted;
}

export function takeOverSql(module: string, adopt: Readonly<Record<string, { model: string; res_id: number }>>, tables: Readonly<Record<string, string>>): string[] {
  return Object.entries(adopt).flatMap(([name, target]) => {
    const table = tables[target.model];
    if (!table || !/^[a-z0-9_]+$/.test(table) || !Number.isInteger(target.res_id)) return [];
    return [[
      `insert into ir_model_data (module, name, model, res_id, noupdate, create_date, write_date)`,
      `select ${literal(module)}, ${literal(name)}, ${literal(target.model)}, ${target.res_id}, false, now() at time zone 'utc', now() at time zone 'utc'`,
      `where exists (select 1 from ${table} where id = ${target.res_id})`,
      `and not exists (select 1 from ir_model_data where model = ${literal(target.model)} and res_id = ${target.res_id} and module not in ('__export__', '__import__'))`,
      `and not exists (select 1 from ir_model_data where module = ${literal(module)} and name = ${literal(name)})`,
    ].join(' ')];
  });
}

export const MODEL_TABLES: Readonly<Record<string, string>> = Object.fromEntries(ODOO_KINDS.map((kind) => [kind.model, kind.table]));

export interface ExportAccess {
  query<T>(sql: string): Promise<T>;
}

export async function fetchRecords(access: ExportAccess, items: readonly { kind: string; key: string }[]): Promise<{ records: FetchedRecord[]; missing: { key: string; why: string }[] }> {
  const records: FetchedRecord[] = [];
  const missing: { key: string; why: string }[] = [];
  const fieldsOf = new Map<string, FieldMeta[]>();
  for (const item of items) {
    const sql = recordSql(item.kind, item.key);
    if (!sql) {
      missing.push({ key: item.key, why: `${item.kind} is not something that can be exported` });
      continue;
    }
    const found = await access.query<{ model: string; id: number; row: Record<string, unknown> } | null>(sql);
    if (!found) {
      missing.push({ key: item.key, why: 'it is no longer in the live app' });
      continue;
    }
    if (!fieldsOf.has(found.model)) fieldsOf.set(found.model, await access.query<FieldMeta[]>(fieldsSql(found.model)));
    const fields = fieldsOf.get(found.model)!;
    const many: Record<string, number[]> = {};
    for (const field of fields.filter((entry) => entry.ttype === 'many2many')) {
      const manySelect = manySql(field, found.id);
      if (manySelect) many[field.name] = await access.query<number[]>(manySelect);
    }
    const own = item.kind === 'edited-view' ? (await access.query<string[]>(ownXmlIdSql(found.model, found.id)))[0] : undefined;
    if (item.kind === 'edited-view' && !own) {
      missing.push({ key: item.key, why: 'the view it edits has no XML id to keep the edit under' });
      continue;
    }
    records.push({ key: item.key, kind: item.kind, model: found.model, id: found.id, row: found.row, fields, many, ...(own ? { own } : {}) });
  }
  return { records, missing };
}

export async function exportCustomizations(access: ExportAccess, items: readonly { kind: string; key: string }[], module: string, versionPrefix: string): Promise<ExportResult> {
  const { records, missing } = await fetchRecords(access, items);
  if (missing.length) return { module, files: [], refused: missing };
  const wanted = records.flatMap(referencesOf);
  const sql = xmlIdsSql(wanted);
  const xmlids = new Map<string, string>();
  for (const entry of sql ? await access.query<{ key: string; xmlid: string }[]>(sql) : []) if (!xmlids.has(entry.key)) xmlids.set(entry.key, entry.xmlid);
  return renderModule(module, records, xmlids, versionPrefix);
}
