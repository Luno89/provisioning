import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { referencesIn, unrecorded, type Recorded, type Unpinned } from './dependency-references.js';

const root = new URL('../../', import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, root), 'utf8');
const pins = JSON.parse(read('dependencies.pins.json')) as { components: { uses?: Recorded[]; shaUses?: Recorded[]; sourceUses?: Recorded[] }[]; unpinned: Unpinned[] };

describe('what the repository downloads', () => {
  it('accounts for every image and chart repository the code names: a recorded use, or listed unpinned with why', () => {
    const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter((file) => file && existsSync(new URL(file, root)));
    const references = files.flatMap((file) => referencesIn(file, read(file)));
    const uses = pins.components.flatMap((component) => [...(component.uses ?? []), ...(component.shaUses ?? []), ...(component.sourceUses ?? [])]);
    expect(references.length).toBeGreaterThan(100);
    expect(unrecorded(references, uses, pins.unpinned, read).map((reference) => `${reference.file}:${reference.line} ${reference.ref}`)).toEqual([]);
  });
});
