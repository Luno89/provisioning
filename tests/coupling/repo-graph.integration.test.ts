import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { graphKey } from './repo-graph.js';
import { WORKSPACES } from './workspaces.js';

const root = mkdtempSync(join(tmpdir(), 'koala-graph-key-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const write = (path: string, text: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };

describe('the key a repository graph is kept under', () => {
  it('changes with the source the graph reads, the code that builds it and what was asked for, and only then', () => {
    git('init', '-q');
    for (const folder of ['apps', 'packages', 'scripts', 'charts', 'tests']) write(`${folder}/a.ts`, 'export const a = 1;\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'start');
    const key = () => graphKey(root, WORKSPACES, { withinFiles: true });
    const first = key();
    expect(key()).toBe(first);

    write('apps/a.ts', 'export const a = 2;\n');
    const edited = key();
    expect(edited).not.toBe(first);

    write('tests/a.ts', 'export const a = 2;\n');
    expect(key()).not.toBe(edited);
    const builder = key();

    write('apps/new.ts', 'export const b = 1;\n');
    expect(key()).not.toBe(builder);

    expect(graphKey(root, WORKSPACES, { withinFiles: true, handOffs: true })).not.toBe(key());
    expect(graphKey(root, WORKSPACES.slice(0, 1), { withinFiles: true })).not.toBe(key());
  });
});
