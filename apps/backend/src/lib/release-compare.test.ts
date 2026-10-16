import { describe, it, expect } from 'vitest';
import { changesSentence, itemChanges, lossLines, newLosses, releaseChanges, schemaChanges, type InventoryItem } from './release-compare.js';

const live = {
  koala_probe: { id: 'integer', name: 'character varying', note: 'text', amount: 'integer', empty: 'text' },
  koala_probe_extra: { id: 'integer' },
  res_partner: { id: 'integer' },
};

describe('what a release changes', () => {
  it('finds the tables and columns it drops and the columns whose type changes, including Odoo keeping old values aside', () => {
    const preview = {
      koala_probe: { id: 'integer', name: 'character varying', amount: 'character varying', amount_moved0: 'integer' },
      res_partner: { id: 'bigint', added: 'text' },
    };
    expect(schemaChanges(live, preview)).toEqual({
      tables: ['koala_probe_extra'],
      columns: [{ table: 'koala_probe', column: 'empty' }, { table: 'koala_probe', column: 'note' }],
      retyped: [
        { table: 'koala_probe', column: 'amount', from: 'integer', to: 'character varying', keptIn: 'amount_moved0' },
        { table: 'res_partner', column: 'id', from: 'integer', to: 'bigint' },
      ],
    });
  });

  it('says what happens to each thing made or changed in the app', () => {
    const item = (key: string, over: Partial<InventoryItem> = {}): InventoryItem => ({ kind: 'view', key, name: `View ${key}`, fingerprint: 'f', active: true, ...over });
    expect(itemChanges(
      [item('1'), item('2'), item('3'), item('4'), item('5', { active: false })],
      [item('1'), item('2', { fingerprint: 'g' }), item('3', { active: false }), item('5', { active: false }), item('6')],
    ).map((change) => [change.key, change.state])).toEqual([['1', 'kept'], ['2', 'reset'], ['3', 'switched-off'], ['4', 'gone'], ['5', 'kept']]);
  });

  it('counts as losing only what held data, or a customization that does not survive', () => {
    const diff = schemaChanges(live, { koala_probe: { id: 'integer', name: 'character varying', amount: 'integer', note: 'text' }, res_partner: { id: 'integer' } });
    const quiet = releaseChanges(diff, { tables: { koala_probe_extra: 0 }, columns: { 'koala_probe.empty': 0 } }, [{ kind: 'field', key: 'x', name: 'Field x_note', state: 'kept' }], 'now');
    expect(quiet).toMatchObject({ losing: false, tables: [{ table: 'koala_probe_extra', rows: 0 }], columns: [{ table: 'koala_probe', column: 'empty', filled: 0 }] });
    expect(lossLines(quiet)).toEqual([]);

    const losing = releaseChanges(diff, { tables: { koala_probe_extra: 2 }, columns: { 'koala_probe.empty': 1 } }, [{ kind: 'view', key: '7', name: 'The view Probe form, edited in the app,', state: 'reset' }], 'now');
    expect(losing.losing).toBe(true);
    expect(lossLines(losing)).toEqual([
      'the table koala_probe_extra is dropped, with its 2 rows',
      'the column koala_probe.empty is dropped; 1 row held a value in it',
      'The view Probe form, edited in the app, is reset',
    ]);
  });

  it('names only what the person was not shown when it is checked again at cut over', () => {
    const diff = schemaChanges(live, { koala_probe: live.koala_probe, koala_probe_extra: live.koala_probe_extra, res_partner: {} });
    const seen = releaseChanges(diff, { tables: {}, columns: { 'res_partner.id': 0 } }, [], 'then');
    const later = releaseChanges(diff, { tables: {}, columns: { 'res_partner.id': 4 } }, [{ kind: 'field', key: 'x', name: 'Field x_note', state: 'gone' }], 'now');
    expect(newLosses(seen, later)).toEqual(['the column res_partner.id is dropped; 4 rows held a value in it', 'Field x_note is gone']);
    expect(newLosses(later, later)).toEqual([]);
  });

  it('says in one sentence what cutting over would lose, or that nothing is lost and what is kept', () => {
    const kept = releaseChanges({ tables: [], columns: [], retyped: [] }, { tables: {}, columns: {} }, [{ kind: 'field', key: 'x', name: 'Field x_note', state: 'kept' }], 'now');
    expect(changesSentence(kept)).toBe('Compared with live, it loses nothing, and the one thing made or changed in the app is kept.');
    const lost = releaseChanges({ tables: ['old'], columns: [], retyped: [] }, { tables: { old: 3 }, columns: {} }, [], 'now');
    expect(changesSentence(lost)).toBe('Cutting it over would lose one thing: the table old is dropped, with its 3 rows. The person confirms that loss to cut over.');
    expect(changesSentence(undefined)).toBe('');
  });
});
