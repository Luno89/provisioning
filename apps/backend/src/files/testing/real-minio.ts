import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { inject } from 'vitest';
import { containerProvider, localCommands, removeSteps, runSteps, type ContainerContext } from '@koala/provision';
import { memoryReporter } from '@koala/provision/testing';
import { STORED_FILES_BUCKET } from '../lib/stored-files.js';
import type { MinioSettings } from '../services/ObjectStore.js';
import { throwawayLabel } from '@koala/engine-core/testing/throwaway-containers';
import { minioStep } from '../wiring/minio-step.js';

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

export async function startMinio(options: { port?: number } = {}): Promise<RealMinio> {
  const name = `koala-minio-test-${randomUUID().slice(0, 8)}`;
  const accessKey = 'koala-test';
  const secretKey = randomBytes(18).toString('hex');
  const container = containerProvider({ name, image: MINIO_TEST_IMAGE, run: [...throwawayLabel(), '-p', `127.0.0.1:${options.port ?? ''}:9000`, '-e', `MINIO_ROOT_USER=${accessKey}`, '-e', `MINIO_ROOT_PASSWORD=${secretKey}`, '-e', 'MINIO_BROWSER=off'], command: ['server', '/data'], publish: [9000] });
  const place = () => ({ endPoint: '127.0.0.1', port: container.published(9000), useSSL: false });
  const step = minioStep(container, place);
  const on: ContainerContext = { commands: localCommands(process.env) };
  const reporter = memoryReporter();
  try {
    await runSteps([step], on, reporter);
  } catch (failure) {
    await removeSteps([step], on, reporter);
    throw failure;
  }
  return {
    settings: { ...place(), accessKey, secretKey },
    name,
    stop: () => removeSteps([step], on, reporter),
    halt: async () => { await on.commands.run({ command: 'docker', args: ['stop', name] }, { line: () => undefined }); },
    resume: () => runSteps([step], on, reporter),
  };
}

export const testBucket = (): string => `${STORED_FILES_BUCKET}-${randomUUID().slice(0, 8)}`;

export function testMinioEnv(bucket: string = testBucket()): Record<string, string> {
  const minio = inject('minio');
  return { MINIO_ENDPOINT: `${minio.endPoint}:${minio.port}`, MINIO_ROOT_USER: minio.accessKey, MINIO_ROOT_PASSWORD: minio.secretKey, MINIO_BUCKET: bucket };
}
