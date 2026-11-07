import type { TestProject } from 'vitest/node';
import { startMinio } from './src/files/testing/real-minio.js';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const minio = await startMinio();
  project.provide('minio', minio.settings);
  return () => minio.stop();
}
