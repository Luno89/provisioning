import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Ran } from './collect.js';
import { readRan, writeRan } from './ran-record.js';

const dir = mkdtempSync(join(tmpdir(), 'koala-ran-record-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const range = (count: number, line: number, fn?: string) => ({ start: { line, column: 1 }, end: { line: line + 2, column: 1 }, count, ...(fn === undefined ? {} : { fn }) });

describe('what one test file ran, kept on disk', () => {
  it('reads back exactly what was written, for every source file it ran', () => {
    const ran: Ran = { testFile: 'apps/backend/src/x.integration.test.ts', files: Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`apps/backend/src/f${index}.ts`, [range(1, 1, 'f'), range(0, 2), range(index, 3)]])) };
    const path = join(dir, 'whole.json');

    writeRan(path, ran);

    expect(readRan(path)).toEqual(ran);
  });

  it('keeps each source file it ran on a line of its own, so no one piece holds the whole of a large run', () => {
    const ran: Ran = { testFile: 't.test.ts', files: { 'a.ts': [range(1, 1, 'a')], 'b.ts': [range(2, 4, 'b')], 'c.ts': [] } };
    const path = join(dir, 'lines.json');

    writeRan(path, ran);

    const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line !== '');
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([{ testFile: 't.test.ts' }, ['a.ts', ran.files['a.ts']], ['b.ts', ran.files['b.ts']], ['c.ts', []]]);
  });

  it('reads a run that ran no source file', () => {
    const path = join(dir, 'empty.json');

    writeRan(path, { testFile: 'none.test.ts', files: {} });

    expect(readRan(path)).toEqual({ testFile: 'none.test.ts', files: {} });
  });
});
