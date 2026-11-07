import { describe, expect, it } from 'vitest';
import { minioSettingsFrom } from './minio-settings.js';

const GIVEN = { MINIO_ENDPOINT: 'luno-minio:9000', MINIO_ROOT_USER: 'koala', MINIO_ROOT_PASSWORD: 's3cret pass', MINIO_BUCKET: 'koala' };

describe('the settings an instance reaches its MinIO with', () => {
  it('reads the address, keys and bucket the chart gives, over plain http inside the cluster', () => {
    expect(minioSettingsFrom(GIVEN)).toEqual({ endPoint: 'luno-minio', port: 9000, useSSL: false, accessKey: 'koala', secretKey: 's3cret pass', bucket: 'koala' });
  });

  it.each([
    [{}, 'MINIO_ENDPOINT, MINIO_ROOT_USER, MINIO_ROOT_PASSWORD, MINIO_BUCKET are not set'],
    [{ ...GIVEN, MINIO_BUCKET: undefined }, 'MINIO_BUCKET is not set'],
    [{ ...GIVEN, MINIO_ROOT_USER: '  ' }, 'MINIO_ROOT_USER is not set'],
    [{ ...GIVEN, MINIO_ROOT_PASSWORD: '', MINIO_ENDPOINT: '' }, 'MINIO_ENDPOINT, MINIO_ROOT_PASSWORD are not set'],
  ])('stops the process naming every setting missing: %j', (env, said) => {
    expect(() => minioSettingsFrom(env)).toThrow(said);
  });

  it.each(['luno-minio', ':9000', 'luno-minio:', 'luno-minio:0', 'luno-minio:65536', 'luno-minio:90a0', 'luno-minio:-1'])('refuses an address that is not a host and a port: %s', (endpoint) => {
    expect(() => minioSettingsFrom({ ...GIVEN, MINIO_ENDPOINT: endpoint })).toThrow(`MINIO_ENDPOINT is not a host and port: ${endpoint}`);
  });

  it('takes the highest and lowest ports there are', () => {
    expect(minioSettingsFrom({ ...GIVEN, MINIO_ENDPOINT: 'm:1' }).port).toBe(1);
    expect(minioSettingsFrom({ ...GIVEN, MINIO_ENDPOINT: 'm:65535' }).port).toBe(65535);
  });

  it.each(['Koala', 'ko', 'koala_files', '-koala', 'koala-', 'a'.repeat(64)])('refuses a bucket name MinIO would refuse: %s', (bucket) => {
    expect(() => minioSettingsFrom({ ...GIVEN, MINIO_BUCKET: bucket })).toThrow(`MINIO_BUCKET is not a bucket name MinIO takes: ${bucket}`);
  });

  it('takes bucket names at the lengths MinIO allows', () => {
    expect(minioSettingsFrom({ ...GIVEN, MINIO_BUCKET: 'abc' }).bucket).toBe('abc');
    expect(minioSettingsFrom({ ...GIVEN, MINIO_BUCKET: 'a'.repeat(63) }).bucket).toBe('a'.repeat(63));
  });
});
