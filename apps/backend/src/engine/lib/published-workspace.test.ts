import { describe, expect, it } from 'vitest';
import { installText, parkingFor, type PublishedWorkspace } from './published-workspace.js';

const PUBLISHED: PublishedWorkspace = { ownerId: 'u1', treeId: 't1', file: {}, fingerprint: 'f1', image: 'img:1', provides: [], lines: [], env: [], baseEnv: [], publishedAt: 't0' };

describe('what a story put aside for its workspace waits on', () => {
  it('is here when main asks for nothing the published workspace lacks', () => {
    expect(parkingFor(PUBLISHED, [])).toEqual({ state: 'here' });
    expect(parkingFor(undefined, [])).toEqual({ state: 'here' });
  });

  it('is coming while the build is on its way, and stuck once it failed or was declined', () => {
    expect(parkingFor(PUBLISHED, ['pip cowsay'])).toEqual({ state: 'coming' });
    expect(parkingFor({ ...PUBLISHED, next: { runId: 'r', stage: 'building', at: 't1' } }, ['pip cowsay'])).toEqual({ state: 'coming' });
    expect(parkingFor({ ...PUBLISHED, next: { runId: 'r', stage: 'failed', reason: 'pip: command not found', at: 't1' } }, ['pip cowsay'])).toEqual({ state: 'stuck', why: 'not rebuilt: the build failed — pip: command not found' });
    expect(parkingFor({ ...PUBLISHED, next: { runId: 'r', stage: 'declined', at: 't1' } }, ['pip cowsay'])).toMatchObject({ state: 'stuck' });
  });
});

describe('a line of a workspace, in words', () => {
  it('names the packages, and shows a script by its first command', () => {
    expect(installText({ via: 'dnf', packages: ['jq', 'ripgrep'] })).toBe('dnf jq, ripgrep');
    expect(installText({ via: 'script', run: '\n  apt-get update && apt-get install -y postgresql-client\necho done' })).toBe('script: apt-get update && apt-get install -y postgresql-client');
    expect(installText({ via: 'script', run: `curl -fsSL ${'x'.repeat(80)}` })).toMatch(/^script: curl -fsSL x+…$/);
  });
});
