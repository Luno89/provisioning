import { describe, it, expect } from 'vitest';
import { rollupProjectStatus, deploymentForProject } from './project-status.js';
import type { DeploymentMetadata, PipelineRunMetadata } from './types.js';

const project = { id: 'p1', name: 'wordcount' };

const run = (over: Partial<PipelineRunMetadata>): PipelineRunMetadata => ({
  id: 'r1', projectId: 'p1', commitSha: 'abc', ref: 'main', status: 'succeeded',
  startedAt: '2026-01-01T00:00:00Z', ...over,
});

const dep = (over: Partial<DeploymentMetadata>): DeploymentMetadata => ({
  id: 'd1', name: 'wordcount', clusterId: 'c1', strategy: 'native', appType: 'gitapp',
  status: 'running', ...over,
});

describe('rolling a project up to one word', () => {
  it('says nothing has been built when there are no runs', () => {
    expect(rollupProjectStatus(project, [], undefined).status).toBe('no-build');
  });

  it('reports a built image that nothing is running as built, not as a failure', () => {
    expect(rollupProjectStatus(project, [run({})], undefined).status).toBe('built');
  });

  it('reports a healthy chain as running', () => {
    expect(rollupProjectStatus(project, [run({})], dep({ status: 'running' })).status).toBe('running');
  });

  it('separates a workload that will not run from a deploy that never landed', () => {
    expect(rollupProjectStatus(project, [run({})], dep({ status: 'unhealthy' })).status).toBe('unhealthy');
    expect(rollupProjectStatus(project, [run({})], dep({ status: 'failed' })).status).toBe('deploy-failed');
  });

  it('carries the pod reason through so the column can explain itself', () => {
    const r = rollupProjectStatus(project, [run({})], dep({ status: 'unhealthy', healthReason: 'web-7d4f: CrashLoopBackOff' }));
    expect(r.reason).toBe('web-7d4f: CrashLoopBackOff');
  });

  it('lets a failed build outrank a pod that is still happily serving the old image', () => {
    const runs = [run({ id: 'old', startedAt: '2026-01-01T00:00:00Z' }),
                  run({ id: 'new', startedAt: '2026-02-01T00:00:00Z', status: 'failed', errorMessage: 'tsc exploded' })];
    const r = rollupProjectStatus(project, runs, dep({ status: 'running' }));
    expect(r.status).toBe('build-failed');
    expect(r.reason).toBe('tsc exploded');
  });

  it('judges by the newest run, not whichever came back first', () => {
    const runs = [run({ id: 'new', startedAt: '2026-02-01T00:00:00Z' }),
                  run({ id: 'old', startedAt: '2026-01-01T00:00:00Z', status: 'failed' })];
    expect(rollupProjectStatus(project, runs, dep({ status: 'running' })).status).toBe('running');
  });

  it('ignores runs belonging to other projects', () => {
    const other = run({ projectId: 'p2', status: 'failed' });
    expect(rollupProjectStatus(project, [other], undefined).status).toBe('no-build');
  });
});

describe('finding the deployment that belongs to a project', () => {
  it('prefers the recorded link', () => {
    const wrongName = dep({ id: 'right', name: 'renamed-since', gitappProjectId: 'p1' });
    const sameName = dep({ id: 'wrong', name: 'wordcount' });
    expect(deploymentForProject(project, [sameName, wrongName])?.id).toBe('right');
  });

  it('falls back to the name for deployments promoted before the link existed', () => {
    expect(deploymentForProject(project, [dep({ id: 'legacy' })])?.id).toBe('legacy');
  });

  it('will not claim a non-gitapp app that happens to share the name', () => {
    const unrelated = dep({ id: 'odoo', appType: 'odoo', name: 'wordcount' });
    expect(deploymentForProject(project, [unrelated])).toBeUndefined();
  });
});
