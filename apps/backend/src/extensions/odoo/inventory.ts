import type { InventoryItem } from '../../lib/release-compare.js';
import { literal } from '../releases/postgres-compare.js';

export interface Kind {
  kind: string;
  table: string;
  model: string;
  key: string;
  name: string;
  made: string;
  fingerprint: string;
}

const MODULE_RECORDS = "('__export__', '__import__', 'studio_customization')";
const VOLATILE = "array['write_date', 'write_uid', 'create_date', 'create_uid', 'last_run', 'arch_prev', 'arch_fs']";

const text = (column: string): string => `coalesce(to_jsonb(${column})->>'en_US', to_jsonb(${column})#>>'{}')`;
const fromModule = (model: string): string =>
  `exists (select 1 from ir_model_data d where d.model = ${literal(model)} and d.res_id = r.id and d.module not in ${MODULE_RECORDS})`;
const settled = `md5((to_jsonb(r) - ${VOLATILE})::text)`;
const ownModules = "(select m.module from ir_model_data m join ir_model o on o.id = m.res_id where m.model = 'ir.model' and o.model = r.model)";
const inGit = `exists (select 1 from ir_model_data d where d.model = 'ir.model.fields' and d.res_id = r.id and d.module not in ${MODULE_RECORDS} and d.module not in ${ownModules})`;

export const ODOO_KINDS: readonly Kind[] = [
  {
    kind: 'field', table: 'ir_model_fields', model: 'ir.model.fields',
    key: "r.model || '.' || r.name",
    name: `'The field ' || ${text('r.field_description')} || ' (' || r.name || ') on ' || r.model || ', made in the app,'`,
    made: `r.state = 'manual' and not ${inGit}`, fingerprint: settled,
  },
  {
    kind: 'model', table: 'ir_model', model: 'ir.model',
    key: 'r.model',
    name: `'The model ' || ${text('r.name')} || ' (' || r.model || '), made in the app,'`,
    made: `r.state = 'manual' and not ${fromModule('ir.model')}`, fingerprint: settled,
  },
  {
    kind: 'view', table: 'ir_ui_view', model: 'ir.ui.view',
    key: "'id:' || r.id",
    name: `'The view ' || r.name || ', made in the app,'`,
    made: `not ${fromModule('ir.ui.view')}`, fingerprint: 'md5(r.arch_db::text)',
  },
  {
    kind: 'edited-view', table: 'ir_ui_view', model: 'ir.ui.view',
    key: "'id:' || r.id",
    name: `'The view ' || r.name || ', edited in the app,'`,
    made: `r.arch_updated and ${fromModule('ir.ui.view')}`, fingerprint: 'md5(r.arch_db::text)',
  },
  {
    kind: 'server-action', table: 'ir_act_server', model: 'ir.actions.server',
    key: "'id:' || r.id",
    name: `'The server action ' || ${text('r.name')} || ', made in the app,'`,
    made: `not ${fromModule('ir.actions.server')}`, fingerprint: settled,
  },
  {
    kind: 'automation', table: 'base_automation', model: 'base.automation',
    key: "'id:' || r.id",
    name: `'The automation ' || ${text('r.name')} || ', made in the app,'`,
    made: `not ${fromModule('base.automation')}`, fingerprint: settled,
  },
  {
    kind: 'report', table: 'ir_act_report_xml', model: 'ir.actions.report',
    key: "'id:' || r.id",
    name: `'The report ' || ${text('r.name')} || ', made in the app,'`,
    made: `not ${fromModule('ir.actions.report')}`, fingerprint: settled,
  },
  {
    kind: 'email-template', table: 'mail_template', model: 'mail.template',
    key: "'id:' || r.id",
    name: `'The email template ' || ${text('r.name')} || ', made in the app,'`,
    made: `not ${fromModule('mail.template')}`, fingerprint: settled,
  },
];

export const presentTablesSql = (): string =>
  `select coalesce(json_agg(c.relname), '[]') from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname in (${[...new Set(ODOO_KINDS.map((kind) => kind.table))].map(literal).join(', ')})`;

export function inventorySql(present: readonly string[], of?: readonly InventoryItem[]): string | undefined {
  const parts = ODOO_KINDS.filter((kind) => present.includes(kind.table)).map((kind) => {
    const keys = (of ?? []).filter((item) => item.kind === kind.kind).map((item) => literal(item.key));
    const which = of ? (keys.length ? `${kind.key} in (${keys.join(', ')})` : 'false') : kind.made;
    return `select ${literal(kind.kind)} as kind, ${kind.key} as key, ${kind.name} as name, ${kind.fingerprint} as fingerprint, coalesce((to_jsonb(r)->>'active')::boolean, true) as active from ${kind.table} r where ${which}`;
  });
  return parts.length ? `select coalesce(json_agg(i order by i.kind, i.key), '[]') from (${parts.join(' union all ')}) i` : undefined;
}

export function inventoryFrom(rows: readonly Partial<InventoryItem>[]): InventoryItem[] {
  return rows
    .filter((row): row is InventoryItem => typeof row.kind === 'string' && typeof row.key === 'string')
    .map((row) => ({ kind: row.kind, key: row.key, name: row.name ?? `${row.kind} ${row.key}`, fingerprint: row.fingerprint ?? '', active: row.active !== false }));
}
