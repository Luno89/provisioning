import { describe, it, expect } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { RunPipelineActivity, yamlDoubleQuoted, workspacePath } from './RunPipelineActivity.js';
import type { ClusterSteps } from './cluster-steps.js';

describe('yamlDoubleQuoted', () => {
  it('leaves an ordinary value untouched', () => {
    expect(yamlDoubleQuoted('production')).toBe('production');
  });

  it('escapes a double quote so it cannot close the YAML string early', () => {
    expect(yamlDoubleQuoted('a"b')).toBe('a\\"b');
  });

  it('escapes a backslash before escaping quotes, so the two do not collide', () => {
    expect(yamlDoubleQuoted('a\\"b')).toBe('a\\\\\\"b');
  });
});

describe('workspacePath', () => {
  it('is the bare workspace root with no subpath', () => {
    expect(workspacePath(undefined)).toBe('/workspace');
  });

  it('joins a relative subpath under the workspace root', () => {
    expect(workspacePath('services/api')).toBe('/workspace/services/api');
    expect(workspacePath('docker/Dockerfile')).toBe('/workspace/docker/Dockerfile');
  });
});

describe('the build job a push starts', () => {
  it('a build verifies TLS for every registry but the instance\'s own', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pipeline-'));
    const gitea = mock<ClusterSteps['gitea']>();
    gitea.getRegistryHosts.mockResolvedValue({ pull: '127.0.0.1:35010', push: 'gitea-http.gitea.svc.cluster.local:3000' });
    gitea.getRawFile.mockImplementation(async (_owner, _repo, file) => (file === 'Dockerfile' ? 'FROM node:22\n' : null));
    gitea.createDeployToken.mockResolvedValue({ name: 'build-token', token: 't' } as never);
    Object.assign(gitea, { adminUsername: 'koala-bot' });
    const access = mock<ClusterSteps['access']>();
    access.own.mockReturnValue({ kind: 'own' } as never);
    access.apply.mockRejectedValue(new Error('stop after the manifest'));
    access.kubectl.mockResolvedValue('');
    gitea.revokeToken.mockResolvedValue(undefined as never);
    try {
      await expect(RunPipelineActivity(
        { giteaOwner: 'u1', giteaRepo: 'shop', ref: 'main', commitSha: 'a'.repeat(40), logFile: join(dir, 'build.log'), runId: 'run1' } as never,
        { access, gitea } as unknown as ClusterSteps,
      )).rejects.toThrow('stop after the manifest');
      const manifest = String(access.apply.mock.calls[0]?.[1]);
      const kaniko = manifest.slice(manifest.indexOf('- name: kaniko'));
      const flags = [...kaniko.matchAll(/- "(--[^"=]+)(?:=([^"]*))?"/g)].map((match) => (match[2] === undefined ? match[1] : `${match[1]}=${match[2]}`));
      expect(flags.filter((flag) => ['--insecure', '--insecure-pull', '--skip-tls-verify'].includes(flag!))).toEqual([]);
      expect(flags).toEqual(expect.arrayContaining([
        '--insecure-registry=gitea-http.gitea.svc.cluster.local:3000',
        '--skip-tls-verify-registry=gitea-http.gitea.svc.cluster.local:3000',
        '--insecure-registry=127.0.0.1:35010',
        '--skip-tls-verify-registry=127.0.0.1:35010',
        '--registry-map=127.0.0.1:35010=gitea-http.gitea.svc.cluster.local:3000',
      ]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
