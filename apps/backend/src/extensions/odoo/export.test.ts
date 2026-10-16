import { describe, it, expect } from 'vitest';
import { exportCustomizations, moduleNameFor, renderModule, takeOverSql, MODEL_TABLES, type FetchedRecord, type FieldMeta } from './export.js';

const VIEW_FIELDS: FieldMeta[] = [
  { name: 'id', ttype: 'integer' }, { name: 'name', ttype: 'char' }, { name: 'model', ttype: 'char' }, { name: 'type', ttype: 'selection' },
  { name: 'priority', ttype: 'integer' }, { name: 'active', ttype: 'boolean' }, { name: 'arch_db', ttype: 'text' }, { name: 'arch_updated', ttype: 'boolean' },
  { name: 'inherit_id', ttype: 'many2one', relation: 'ir.ui.view' }, { name: 'write_date', ttype: 'datetime' },
  { name: 'group_ids', ttype: 'many2many', relation: 'res.groups', relationTable: 'ir_ui_view_group_rel', column1: 'view_id', column2: 'group_id' },
];

const FIELD_FIELDS: FieldMeta[] = [
  { name: 'name', ttype: 'char' }, { name: 'field_description', ttype: 'char' }, { name: 'ttype', ttype: 'selection' }, { name: 'state', ttype: 'selection' },
  { name: 'model', ttype: 'char' }, { name: 'model_id', ttype: 'many2one', relation: 'ir.model' }, { name: 'required', ttype: 'boolean' },
];

const view: FetchedRecord = {
  key: 'id:42', kind: 'view', model: 'ir.ui.view', id: 42,
  row: { id: 42, name: 'Probe & more', model: 'koala.probe', type: 'form', priority: 16, active: true, arch_db: { en_US: '<form><field name="name"/></form>' }, arch_updated: false, inherit_id: 7, write_date: 'x' },
  fields: VIEW_FIELDS,
  many: { group_ids: [3] },
};

const field: FetchedRecord = {
  key: 'koala.probe.x_note', kind: 'field', model: 'ir.model.fields', id: 900,
  row: { name: 'x_note', field_description: { en_US: 'Note <i>' }, ttype: 'char', state: 'manual', model: 'koala.probe', model_id: 55, required: false },
  fields: FIELD_FIELDS,
  many: {},
};

const edited: FetchedRecord = {
  key: 'id:186', kind: 'edited-view', model: 'ir.ui.view', id: 186,
  row: { id: 186, name: 'koala.probe.form', arch_db: { en_US: '<form><field name="x_note"/></form>' }, arch_updated: true, priority: 16 },
  fields: VIEW_FIELDS,
  many: {},
  own: 'koala_probe.probe_form',
};

const xmlids = new Map([['ir.ui.view:7', 'koala_probe.probe_form'], ['res.groups:3', 'base.group_user'], ['ir.model:55', 'koala_probe.model_koala_probe']]);

describe('exporting what was made in the app', () => {
  it('writes each record exactly, naming what it points at by XML id, into one module that depends on what it rests on', () => {
    const result = renderModule('shop_customizations', [field, view, edited], xmlids, '20.0');
    expect(result.refused).toEqual([]);
    const files = Object.fromEntries(result.files.map((file) => [file.path, file.content]));
    expect(Object.keys(files)).toEqual([
      'addons/shop_customizations/__init__.py',
      'addons/shop_customizations/__manifest__.py',
      'addons/shop_customizations/data/fields.xml',
      'addons/shop_customizations/data/views.xml',
      'addons/shop_customizations/adopt.json',
    ]);
    expect(files['addons/shop_customizations/__manifest__.py']).toContain("'depends': ['base', 'koala_probe'],");
    expect(files['addons/shop_customizations/__manifest__.py']).toContain("'data': ['data/fields.xml', 'data/views.xml'],");
    expect(files['addons/shop_customizations/__manifest__.py']).toContain("'version': '20.0.1.0.0',");
    const fields = files['addons/shop_customizations/data/fields.xml']!;
    expect(fields).toContain('<record id="field_koala_probe__x_note" model="ir.model.fields">');
    expect(fields).toContain('<field name="field_description">Note &lt;i&gt;</field>');
    expect(fields).toContain('<field name="model_id" ref="koala_probe.model_koala_probe"/>');
    expect(fields).toContain('<field name="required" eval="False"/>');
    const views = files['addons/shop_customizations/data/views.xml']!;
    expect(views).toContain('<record id="view_probe_more_42" model="ir.ui.view">');
    expect(views).toContain('<field name="arch" type="xml"><form><field name="name"/></form></field>');
    expect(views).toContain('<field name="inherit_id" ref="koala_probe.probe_form"/>');
    expect(views).toContain(`<field name="group_ids" eval="[Command.set([ref('base.group_user')])]"/>`);
    expect(views).not.toContain('write_date');
    expect(views).not.toContain('arch_updated');
    expect(views).toContain('<record id="koala_probe.probe_form" model="ir.ui.view">\n    <field name="arch" type="xml"><form><field name="x_note"/></form></field>\n  </record>');
    expect(JSON.parse(files['addons/shop_customizations/adopt.json']!)).toEqual({
      field_koala_probe__x_note: { model: 'ir.model.fields', res_id: 900 },
      view_probe_more_42: { model: 'ir.ui.view', res_id: 42 },
    });
  });

  it('names another exported record by its new XML id', () => {
    const child: FetchedRecord = { ...view, key: 'id:43', id: 43, row: { ...view.row, id: 43, name: 'Child', inherit_id: 42 }, many: {} };
    const result = renderModule('shop_customizations', [view, child], xmlids, '20.0');
    expect(result.files.find((file) => file.path.endsWith('views.xml'))!.content).toContain('<field name="inherit_id" ref="view_probe_more_42"/>');
  });

  it('refuses the whole export when an item points at something with no XML id, or holds a file, and writes nothing', () => {
    const lost = renderModule('shop_customizations', [{ ...view, row: { ...view.row, inherit_id: 999 } }], xmlids, '20.0');
    expect(lost).toEqual({ module: 'shop_customizations', files: [], refused: [{ key: 'id:42', why: 'its inherit_id points at a ir.ui.view record (id 999) that has no XML id to name it by' }] });
    const withFile = renderModule('shop_customizations', [{ ...field, fields: [...FIELD_FIELDS, { name: 'image', ttype: 'binary' }], row: { ...field.row, image: 'AAAA' } }], xmlids, '20.0');
    expect(withFile.refused).toEqual([{ key: 'koala.probe.x_note', why: 'its image holds a file, which is not exported' }]);
  });

  it('reads the records through the database and says which are gone', async () => {
    const asked: string[] = [];
    const answers = (sql: string): unknown => {
      asked.push(sql.slice(0, 40));
      if (sql.includes("r.model || '.' || r.name = 'koala.probe.gone'")) return null;
      if (sql.includes('from ir_model_fields r where')) return { model: 'ir.model.fields', id: 900, row: field.row };
      if (sql.includes('from ir_model_fields f where')) return FIELD_FIELDS;
      if (sql.includes('from ir_model_data d')) return [{ key: 'ir.model:55', xmlid: 'koala_probe.model_koala_probe' }];
      return [];
    };
    const access = { query: async <T,>(sql: string) => answers(sql) as T };
    const gone = await exportCustomizations(access, [{ kind: 'field', key: 'koala.probe.gone' }, { kind: 'nonsense', key: 'x' }], 'shop_customizations', '20.0');
    expect(gone.refused).toEqual([{ key: 'koala.probe.gone', why: 'it is no longer in the live app' }, { key: 'x', why: 'nonsense is not something that can be exported' }]);
    const found = await exportCustomizations(access, [{ kind: 'field', key: 'koala.probe.x_note' }], 'shop_customizations', '20.0');
    expect(found.refused).toEqual([]);
    expect(found.files.some((file) => file.content.includes('ref="koala_probe.model_koala_probe"'))).toBe(true);
  });

  it('names the module after the project\'s release, and takes over only records that exist and have no XML id yet', () => {
    expect(moduleNameFor('Delivery-Labels-1n1rvd')).toBe('delivery_labels_customizations');
    const [sql, ...rest] = takeOverSql('shop_customizations', { view_x_42: { model: 'ir.ui.view', res_id: 42 }, odd: { model: 'res.partner', res_id: 1 } }, MODEL_TABLES);
    expect(rest).toEqual([]);
    expect(sql).toContain("select 'shop_customizations', 'view_x_42', 'ir.ui.view', 42, false");
    expect(sql).toContain('where exists (select 1 from ir_ui_view where id = 42)');
    expect(sql).toContain("and not exists (select 1 from ir_model_data where model = 'ir.ui.view' and res_id = 42 and module not in ('__export__', '__import__'))");
  });
});
