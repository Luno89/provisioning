import { describe, expect, it } from 'vitest';
import type { PipelineRunMetadata } from '../../platform/index.js';
import type { OdooRelease } from '../lib/odoo-release.js';
import type { ReleasesStore } from '../store.js';

const run = (id: string, extra: Partial<PipelineRunMetadata> = {}): PipelineRunMetadata => ({
  id,
  projectId: 'project-1',
  commitSha: 'abc123',
  ref: 'refs/heads/main',
  status: 'queued',
  startedAt: '2026-10-01T00:00:00.000Z',
  ...extra,
});

const release = (id: string, extra: Partial<OdooRelease> = {}): OdooRelease => ({
  id,
  ownerId: 'owner-1',
  projectId: 'project-1',
  pipelineRunId: `run-${id}`,
  commit: 'abc123',
  image: 'registry/app:abc123',
  state: 'preview',
  host: 'app.example',
  startedAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...extra,
});

export function releasesStoreContract(make: () => Promise<ReleasesStore>): void {
  describe('pipeline builds', () => {
    it('keeps a build as it was saved, replaces it whole when saved again, and lists them all', async () => {
      const store = await make();
      expect(await store.getPipelineRuns()).toEqual([]);
      const full = run('r1', { imageTag: 'tag', logFile: '/logs/r1', temporalWorkflowId: 'wf', finishedAt: '2026-10-01T00:05:00.000Z', releaseHeld: 'held', extra: { nested: [1, 2] } });
      await store.savePipelineRun(full);
      await store.savePipelineRun(run('r2', { projectId: 'project-2' }));
      expect(await store.getPipelineRuns()).toEqual([full, run('r2', { projectId: 'project-2' })]);
      await store.savePipelineRun(run('r1', { status: 'failed' }));
      const replaced = (await store.getPipelineRuns()).find((stored) => stored.id === 'r1');
      expect(replaced).toEqual(run('r1', { status: 'failed' }));
      expect(replaced).not.toHaveProperty('imageTag');
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.savePipelineRun(run('r1', { extra: { list: ['a'] } }));
      const [read] = await store.getPipelineRuns();
      read!.status = 'failed';
      (read!.extra as { list: string[] }).list.push('b');
      const [again] = await store.getPipelineRuns();
      expect(again?.status).toBe('queued');
      expect(again?.extra).toEqual({ list: ['a'] });
    });

    it('records a build\'s information with the defaults of a build just queued, and answers with what it kept', async () => {
      const store = await make();
      const before = Date.now();
      const made = await store.savePipelineRunInfo({ id: 'r1' });
      expect(made).toMatchObject({ id: 'r1', projectId: '', commitSha: '', ref: '', status: 'queued' });
      expect(Date.parse(made.startedAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(made.startedAt)).toBeLessThanOrEqual(Date.now());
      expect(await store.getPipelineRuns()).toEqual([made]);
    });

    it('records a build with no id under an id of its own', async () => {
      const store = await make();
      const first = await store.savePipelineRunInfo({ projectId: 'project-1' });
      const second = await store.savePipelineRunInfo({ projectId: 'project-1' });
      expect(first.id).toBeTruthy();
      expect(second.id).toBeTruthy();
      expect(second.id).not.toBe(first.id);
      expect((await store.getPipelineRuns()).map((stored) => stored.id).sort()).toEqual([first.id, second.id].sort());
    });

    it('merges new information over what the build already has, ignoring what is left undefined', async () => {
      const store = await make();
      await store.savePipelineRunInfo({ id: 'r1', projectId: 'project-1', commitSha: 'abc', ref: 'main', status: 'running', startedAt: '2026-10-01T00:00:00.000Z', imageTag: 'tag' });
      const updated = await store.savePipelineRunInfo({ id: 'r1', status: 'succeeded', finishedAt: '2026-10-01T00:09:00.000Z', imageTag: undefined, commitSha: undefined });
      expect(updated).toEqual({ id: 'r1', projectId: 'project-1', commitSha: 'abc', ref: 'main', status: 'succeeded', startedAt: '2026-10-01T00:00:00.000Z', imageTag: 'tag', finishedAt: '2026-10-01T00:09:00.000Z' });
      expect(await store.getPipelineRuns()).toEqual([updated]);
    });

    it('falls back to the default for a field the information gives empty', async () => {
      const store = await make();
      await store.savePipelineRunInfo({ id: 'r1', projectId: 'project-1', status: 'running' });
      const updated = await store.savePipelineRunInfo({ id: 'r1', projectId: '', commitSha: '' });
      expect(updated).toMatchObject({ projectId: '', commitSha: '', status: 'running' });
    });

    it('hands back a copy of the information it answers with', async () => {
      const store = await make();
      const made = await store.savePipelineRunInfo({ id: 'r1', extra: { list: ['a'] } });
      (made.extra as { list: string[] }).list.push('b');
      expect((await store.getPipelineRuns())[0]?.extra).toEqual({ list: ['a'] });
    });
  });

  describe('Odoo releases', () => {
    it('lists a person\'s releases newest first, and only theirs', async () => {
      const store = await make();
      await store.saveOdooRelease(release('old', { startedAt: '2026-10-01T00:00:00.000Z' }));
      await store.saveOdooRelease(release('new', { startedAt: '2026-10-03T00:00:00.000Z' }));
      await store.saveOdooRelease(release('mid', { startedAt: '2026-10-02T00:00:00.000Z' }));
      await store.saveOdooRelease(release('other', { ownerId: 'owner-2', startedAt: '2026-10-04T00:00:00.000Z' }));
      expect((await store.getOdooReleases('owner-1')).map((stored) => stored.id)).toEqual(['new', 'mid', 'old']);
      expect((await store.getOdooReleases('owner-2')).map((stored) => stored.id)).toEqual(['other']);
      expect(await store.getOdooReleases('nobody')).toEqual([]);
    });

    it('lists one project\'s releases when a project is named', async () => {
      const store = await make();
      await store.saveOdooRelease(release('a1', { projectId: 'a', startedAt: '2026-10-01T00:00:00.000Z' }));
      await store.saveOdooRelease(release('b1', { projectId: 'b', startedAt: '2026-10-02T00:00:00.000Z' }));
      await store.saveOdooRelease(release('a2', { projectId: 'a', startedAt: '2026-10-03T00:00:00.000Z' }));
      expect((await store.getOdooReleases('owner-1', 'a')).map((stored) => stored.id)).toEqual(['a2', 'a1']);
      expect((await store.getOdooReleases('owner-1', 'b')).map((stored) => stored.id)).toEqual(['b1']);
      expect(await store.getOdooReleases('owner-1', 'c')).toEqual([]);
      expect((await store.getOdooReleases('owner-1')).map((stored) => stored.id)).toEqual(['a2', 'b1', 'a1']);
    });

    it('keeps a release as it was saved and replaces it whole when saved again', async () => {
      const store = await make();
      const full = release('r1', {
        slot: 'a',
        previewHost: 'preview.example',
        reason: 'because',
        liveAt: '2026-10-01T01:00:00.000Z',
        replacedBy: 'r2',
        again: 'r0',
        restore: { mode: 'copy', version: '20.0', modules: 3 },
        toldAt: '2026-10-01T00:00:00.000Z',
      });
      await store.saveOdooRelease(full);
      expect(await store.getOdooReleases('owner-1')).toEqual([full]);
      await store.saveOdooRelease(release('r1', { state: 'live', updatedAt: '2026-10-02T00:00:00.000Z' }));
      const [replaced] = await store.getOdooReleases('owner-1');
      expect(replaced).toEqual(release('r1', { state: 'live', updatedAt: '2026-10-02T00:00:00.000Z' }));
      expect(replaced).not.toHaveProperty('slot');
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveOdooRelease(release('r1', { restore: { mode: 'copy', modules: 1 } }));
      const [read] = await store.getOdooReleases('owner-1');
      read!.state = 'failed';
      read!.restore!.modules = 99;
      const [again] = await store.getOdooReleases('owner-1');
      expect(again?.state).toBe('preview');
      expect(again?.restore?.modules).toBe(1);
    });
  });

  describe('telling the person about a release', () => {
    it('marks a release told only for the update it was told about, and says whether it did', async () => {
      const store = await make();
      await store.saveOdooRelease(release('r1', { updatedAt: '2026-10-02T00:00:00.000Z' }));
      expect(await store.markOdooReleaseTold('r1', '2026-10-01T00:00:00.000Z')).toBe(false);
      expect((await store.getOdooReleases('owner-1'))[0]).not.toHaveProperty('toldAt');
      expect(await store.markOdooReleaseTold('r1', '2026-10-02T00:00:00.000Z')).toBe(true);
      expect((await store.getOdooReleases('owner-1'))[0]?.toldAt).toBe('2026-10-02T00:00:00.000Z');
    });

    it('tells a release once, so a second marking of the same update says no', async () => {
      const store = await make();
      await store.saveOdooRelease(release('r1', { updatedAt: '2026-10-02T00:00:00.000Z' }));
      const results = await Promise.all([
        store.markOdooReleaseTold('r1', '2026-10-02T00:00:00.000Z'),
        store.markOdooReleaseTold('r1', '2026-10-02T00:00:00.000Z'),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await store.markOdooReleaseTold('r1', '2026-10-02T00:00:00.000Z')).toBe(false);
    });

    it('says no for a release it does not have, and tells a changed release again', async () => {
      const store = await make();
      expect(await store.markOdooReleaseTold('never', '2026-10-02T00:00:00.000Z')).toBe(false);
      await store.saveOdooRelease(release('r1', { updatedAt: '2026-10-02T00:00:00.000Z' }));
      await store.markOdooReleaseTold('r1', '2026-10-02T00:00:00.000Z');
      await store.saveOdooRelease(release('r1', { updatedAt: '2026-10-03T00:00:00.000Z', toldAt: '2026-10-02T00:00:00.000Z' }));
      expect(await store.markOdooReleaseTold('r1', '2026-10-03T00:00:00.000Z')).toBe(true);
      expect((await store.getOdooReleases('owner-1'))[0]?.toldAt).toBe('2026-10-03T00:00:00.000Z');
    });

    it('marks every release never told as told at its last update, and counts them', async () => {
      const store = await make();
      await store.saveOdooRelease(release('r1', { updatedAt: '2026-10-02T00:00:00.000Z', startedAt: '2026-10-01T00:00:00.000Z' }));
      await store.saveOdooRelease(release('r2', { ownerId: 'owner-2', updatedAt: '2026-10-03T00:00:00.000Z' }));
      await store.saveOdooRelease(release('r3', { updatedAt: '2026-10-04T00:00:00.000Z', toldAt: '2026-10-01T00:00:00.000Z', startedAt: '2026-10-02T00:00:00.000Z' }));
      expect(await store.markOdooReleasesTold()).toBe(2);
      expect(await store.markOdooReleasesTold()).toBe(0);
      const mine = await store.getOdooReleases('owner-1');
      expect(mine.find((stored) => stored.id === 'r1')?.toldAt).toBe('2026-10-02T00:00:00.000Z');
      expect(mine.find((stored) => stored.id === 'r3')?.toldAt).toBe('2026-10-01T00:00:00.000Z');
      expect((await store.getOdooReleases('owner-2'))[0]?.toldAt).toBe('2026-10-03T00:00:00.000Z');
    });
  });
}
