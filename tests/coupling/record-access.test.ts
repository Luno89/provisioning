import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGraph, isTest, type Graph } from './graph.js';
import { mongoRecords, UNNAMED } from './record-access.js';

const ROOT = join(import.meta.dirname, 'fixture-records');

const graph: Graph = buildGraph({
  projects: [{ tsconfig: join(ROOT, 'tsconfig.json'), owns: () => true, records: mongoRecords }],
  root: ROOT,
  calledFrom: (file) => !isTest(file),
  withinFiles: true,
});

const touchedBy = (name: string): string[] => graph.records.filter((record) => graph.units[record.unit]?.name === name)
  .map((record) => `${record.writes ? 'writes' : 'reads'} ${record.collection}`).sort();

describe('Stored records a call reads or writes', () => {
  it('names a collection reached through a getter, called on directly or inline', () => {
    expect(touchedBy('Store.getTrees')).toEqual(['reads trees']);
    expect(touchedBy('Store.saveRun')).toEqual(['writes runs']);
  });

  it('names the collection a caller hands to a helper that writes it, and nothing inside the helper', () => {
    expect(touchedBy('Store.saveTree')).toEqual(['writes trees']);
    expect(touchedBy('put')).toEqual([]);
  });

  it('names the collection of a Records wrapper by the name it was made with, through its methods and its raw collection', () => {
    expect(touchedBy('Store.listNotes')).toEqual(['reads notes']);
    expect(touchedBy('Store.saveNote')).toEqual(['writes notes']);
    expect(touchedBy('Store.notesRaw')).toEqual(['reads notes']);
    expect(graph.records.filter((record) => record.site.file.startsWith('src/platform/lib/'))).toEqual([]);
  });

  it('takes a change stream a store follows as a read of its collection', () => {
    expect(touchedBy('Store.follow')).toEqual(['reads trees']);
  });

  it('says when the collection is named only at run time', () => {
    expect(touchedBy('Store.named')).toEqual([`writes ${UNNAMED}`]);
  });

  it('takes setting a cookie as a write and reading it by name as a read', () => {
    expect(touchedBy('signIn')).toEqual(['writes cookie session']);
    expect(touchedBy('guard')).toEqual(['reads cookie session']);
  });
});
