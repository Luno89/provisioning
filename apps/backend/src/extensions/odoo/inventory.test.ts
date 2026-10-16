import { describe, it, expect } from 'vitest';
import { inventoryFrom, inventorySql } from './inventory.js';

describe('the Odoo inventory query', () => {
  it('lists what was made or edited in the app from the tables there are, and nothing from the others', () => {
    const sql = inventorySql(['ir_model_fields', 'ir_ui_view'])!;
    expect(sql).toContain("from ir_model_fields r where r.state = 'manual' and not exists (select 1 from ir_model_data d where d.model = 'ir.model.fields' and d.res_id = r.id and d.module not in ('__export__', '__import__', 'studio_customization') and d.module not in (select m.module from ir_model_data m join ir_model o on o.id = m.res_id where m.model = 'ir.model' and o.model = r.model))");
    expect(sql).toContain('r.arch_updated and exists (select 1 from ir_model_data d');
    expect(sql).toContain("d.module not in ('__export__', '__import__', 'studio_customization')");
    expect(sql).not.toContain('mail_template');
    expect(sql).not.toContain('base_automation');
    expect(inventorySql([])).toBeUndefined();
  });

  it('reads the same items back by their keys, whatever has become of them', () => {
    const sql = inventorySql(['ir_model_fields', 'ir_ui_view'], [{ kind: 'edited-view', key: "id:7'", name: 'v', fingerprint: 'f', active: true }])!;
    expect(sql).toContain("where 'id:' || r.id in ('id:7''')");
    expect(sql).not.toContain('r.arch_updated and');
    expect(sql).toContain("from ir_model_fields r where false");
  });

  it('keeps only rows that say what they are', () => {
    expect(inventoryFrom([{ kind: 'field', key: 'a.b', fingerprint: 'f' }, { name: 'nothing' }])).toEqual([{ kind: 'field', key: 'a.b', name: 'field a.b', fingerprint: 'f', active: true }]);
  });
});
