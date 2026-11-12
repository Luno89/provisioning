import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { inject } from 'vitest';
import { ignore } from '@koala/engine-core/failures';
import { nodeProcesses, succeeded, type Processes } from '../../platform/index.js';
import { STORED_FILES_BUCKET } from '../lib/stored-files.js';
import type { MinioSettings } from '../services/ObjectStore.js';
import { throwawayLabel } from '@koala/engine-core/testing/throwaway-containers';

const CHART_VALUES = resolve(import.meta.dirname, '../../../../../charts/instance/values.yaml');

export const MINIO_TEST_IMAGE: string = (parse(readFileSync(CHART_VALUES, 'utf8')) as { minio: { image: string } }).minio.image;

declare module 'vitest' {
  export interface ProvidedContext {
    minio: Omit<MinioSettings, 'bucket'>;
  }
}

export interface RealMinio {
  settings: Omit<MinioSettings, 'bucket'>;
  name: string;
  stop(): Promise<void>;
  halt(): Promise<void>;
  resume(): Promise<void>;
}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export async function startMinio(processes: Processes = nodeProcesses, options: { port?: number } = {}): Promise<RealMinio> {
  const name = `koala-minio-test-${randomUUID().slice(0, 8)}`;
  const accessKey = 'koala-test';
  const secretKey = randomBytes(18).toString('hex');
  const docker = (...args: string[]): Promise<string> => succeeded(processes, { command: 'docker', args });
  await docker('run', '-d', '--name', name, ...throwawayLabel(), '-p', `127.0.0.1:${options.port ?? ''}:9000`, '-e', `MINIO_ROOT_USER=${accessKey}`, '-e', `MINIO_ROOT_PASSWORD=${secretKey}`, '-e', 'MINIO_BROWSER=off', MINIO_TEST_IMAGE, 'server', '/data');
  const stop = async (): Promise<void> => { await docker('rm', '-f', name); };
  const ready = async (port: number): Promise<void> => {
    for (;;) {
      if ((await docker('inspect', '-f', '{{.State.Running}}', name)).trim() !== 'true') {
        const said = await processes.run({ command: 'docker', args: ['logs', '--tail', '20', name] });
        throw new Error(`the throwaway MinIO ${name} stopped while starting:\n${said.stdout}${said.stderr}`);
      }
      const answer = await fetch(`http://127.0.0.1:${port}/minio/health/ready`).catch(ignore('MinIO is still starting and not listening yet; the loop asks again'));
      if (answer?.ok) return;
      await pause(200);
    }
  };
  try {
    const port = Number((await docker('port', name, '9000')).split('\n')[0]!.split(':').pop()!.trim());
    await ready(port);
    return {
      settings: { endPoint: '127.0.0.1', port, useSSL: false, accessKey, secretKey },
      name,
      stop,
      halt: async () => { await docker('stop', name); },
      resume: async () => { await docker('start', name); await ready(port); },
    };
  } catch (failure) {
    await stop();
    throw failure;
  }
}

export const testBucket = (): string => `${STORED_FILES_BUCKET}-${randomUUID().slice(0, 8)}`;

export function testMinioEnv(bucket: string = testBucket()): Record<string, string> {
  const minio = inject('minio');
  return { MINIO_ENDPOINT: `${minio.endPoint}:${minio.port}`, MINIO_ROOT_USER: minio.accessKey, MINIO_ROOT_PASSWORD: minio.secretKey, MINIO_BUCKET: bucket };
}
