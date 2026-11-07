import { describe, expect, it } from 'vitest';
import { chartMinioImage, envArgs, minioRun, ownedBySplit, sharedProjectDatabases, splitNames, splitPlace } from './split-stack.js';

describe('a split stack of its own', () => {
  const names = splitNames('abc123');

  it('names its databases, containers and Temporal namespace after one stamp, so two runs never meet', () => {
    expect(names.namespace).toBe('split-abc123');
    expect(names.databases).toEqual({ root: 'koala_split_root_abc123', instance: 'koala_split_instance_abc123', hub: 'koala_split_hub_abc123' });
    expect(Object.values(names.containers).every((name) => name.startsWith('nw-split-') && name.endsWith('-abc123'))).toBe(true);
    expect(splitNames('other').databases.root).not.toBe(names.databases.root);
  });

  it('places each side on its own port and database, the instance on one of its own too', () => {
    const place = splitPlace(names, { root: 1, instance: 2, hub: 3, instanceGateway: 4, rootGateway: 5, hubGateway: 6, smtp: 7, mailApi: 8, metrics: 9, files: 10 });
    expect(place).toEqual({
      rootUrl: 'http://localhost:1', instanceUrl: 'http://localhost:2', hubUrl: 'http://localhost:3',
      rootApiPort: 1, instanceApiPort: 2, hubApiPort: 3,
      rootDatabase: 'koala_split_root_abc123', hubDatabase: 'koala_split_hub_abc123', instanceDatabase: 'koala_split_instance_abc123',
    });
  });

  it('drops only the databases it made, never the dev stack\'s', () => {
    expect(ownedBySplit('koala_split_root_abc123')).toBe(true);
    expect(ownedBySplit('provisioning')).toBe(false);
    expect(ownedBySplit('koala_root')).toBe(false);
  });

  it('drops the database of each project its own hub holds, and nothing named otherwise', () => {
    expect(sharedProjectDatabases(['0cb63c344e557be8b16403bf', 'koala_hub', 7, '../admin'])).toEqual(['hub_0cb63c344e557be8b16403bf']);
  });

  it('hands each value to docker as its own -e', () => {
    expect(envArgs({ ROLE: 'root', PORT: '1' })).toEqual(['-e', 'ROLE=root', '-e', 'PORT=1']);
  });

  it('runs the instance\'s MinIO from the chart\'s own image, on loopback, its console off and its keys made for the run', () => {
    expect(chartMinioImage()).toMatch(/minio:RELEASE\.[^@]+@sha256:[0-9a-f]{64}$/);
    const first = minioRun(9100);
    const second = minioRun(9100);
    expect(first.args.slice(0, 4)).toEqual(['-p', '127.0.0.1:9100:9000', '-e', 'MINIO_BROWSER=off']);
    expect(first.args.slice(-3)).toEqual([chartMinioImage(), 'server', '/data']);
    expect(first.args).toContain(`MINIO_ROOT_USER=${first.env.MINIO_ROOT_USER}`);
    expect(first.args).toContain(`MINIO_ROOT_PASSWORD=${first.env.MINIO_ROOT_PASSWORD}`);
    expect(first.env.MINIO_ENDPOINT).toBe('127.0.0.1:9100');
    expect(first.env.MINIO_BUCKET).toBe('koala');
    expect(first.env.MINIO_ROOT_PASSWORD.length).toBeGreaterThanOrEqual(40);
    expect(second.env.MINIO_ROOT_USER).not.toBe(first.env.MINIO_ROOT_USER);
    expect(second.env.MINIO_ROOT_PASSWORD).not.toBe(first.env.MINIO_ROOT_PASSWORD);
  });
});
