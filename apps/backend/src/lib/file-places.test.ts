import { describe, expect, it } from 'vitest';
import { cleanPath, fileServersOf, folderFor, placeProblem, within } from './file-places.js';

describe('the file servers a person has', () => {
  const deployments = [
    { id: 'm1', name: 'minio', appType: 'minio', status: 'running', clusterId: 'c', ownerId: 'u1', minioRootPassword: 'pw' },
    { id: 'n1', name: 'cloud', appType: 'nextcloud', status: 'running', clusterId: 'c', ownerId: 'u1', nextcloudAdminPassword: 'pw' },
    { id: 'n0', name: 'old-cloud', appType: 'nextcloud', status: 'running', clusterId: 'c', ownerId: 'u1' },
    { id: 'm2', name: 'theirs', appType: 'minio', status: 'running', clusterId: 'c', ownerId: 'u2', minioRootPassword: 'pw' },
    { id: 'm3', name: 'stopped', appType: 'minio', status: 'failed', clusterId: 'c', ownerId: 'u1', minioRootPassword: 'pw' },
  ];

  it('are their running MinIO and Nextcloud deployments Koala holds the credentials of', () => {
    expect(fileServersOf(deployments, 'u1')).toEqual([
      { kind: 'nextcloud', deploymentId: 'n1', name: 'cloud', clusterId: 'c' },
      { kind: 'minio', deploymentId: 'm1', name: 'minio', clusterId: 'c' },
    ]);
  });

  it('says when a project\'s server is gone', () => {
    const servers = fileServersOf(deployments, 'u1');
    expect(placeProblem({ kind: 'minio', deploymentId: 'm1', folder: 'shop' }, servers)).toBeUndefined();
    expect(placeProblem({ kind: 'minio', deploymentId: 'm3', folder: 'shop' }, servers)).toBe('its file server is not running any more');
  });
});

describe('paths in a project\'s files', () => {
  it('are cleaned and kept inside', () => {
    expect(cleanPath('/docs//./spec.pdf')).toEqual({ ok: true, path: 'docs/spec.pdf' });
    expect(cleanPath('docs/../../etc')).toMatchObject({ ok: false });
    expect(cleanPath('')).toEqual({ ok: false, why: 'a file needs a name' });
    expect(cleanPath('', { allowRoot: true })).toEqual({ ok: true, path: '' });
    expect(cleanPath('a\\b')).toMatchObject({ ok: false });
  });

  it('sit under the project\'s folder, named once from the project', () => {
    expect(folderFor('Axial Concepts — Web Portal!')).toBe('axial-concepts-web-portal');
    expect(folderFor('???')).toBe('files');
    expect(within('shop', 'docs/a.pdf')).toBe('shop/docs/a.pdf');
    expect(within('shop', '')).toBe('shop');
  });
});
