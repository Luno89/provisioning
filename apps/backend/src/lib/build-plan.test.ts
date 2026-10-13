import { describe, it, expect } from 'vitest';
import { buildPlanAt, isCommitSha } from './build-plan.js';

const repo = (files: Record<string, string>) => async (path: string) => files[path] ?? null;

describe('what a commit builds', () => {
  it('builds the root Dockerfile when there is no pipeline file', async () => {
    expect(await buildPlanAt(repo({ Dockerfile: 'FROM odoo:18' }), 'c0ffee1234')).toEqual({ build: true, config: null, dockerfile: 'Dockerfile', notes: ['No .provisioning/pipeline.yml — building the repo root Dockerfile'] });
  });

  it('builds the Dockerfile the pipeline file names', async () => {
    const plan = await buildPlanAt(repo({ '.provisioning/pipeline.yml': 'dockerfile: docker/app.Dockerfile\n', 'docker/app.Dockerfile': 'FROM node:22-alpine' }), 'c0ffee1234');
    expect(plan).toMatchObject({ build: true, dockerfile: 'docker/app.Dockerfile' });
  });

  it('has nothing to build when the commit holds no Dockerfile, and says which commit', async () => {
    expect(await buildPlanAt(repo({ '.gitignore': 'node_modules' }), 'c0ffee1234')).toEqual({ build: false, reason: 'there is no Dockerfile at "Dockerfile" in c0ffee12, so there is nothing to build into an image' });
  });

  it('takes only a commit hash as a commit, so nothing else reaches the build\'s shell', () => {
    expect(isCommitSha('4b453b7237e5a4c8d9655f6b4599d40948a75132')).toBe(true);
    expect(isCommitSha('main; rm -rf /')).toBe(false);
    expect(isCommitSha('ABC')).toBe(false);
  });
});
