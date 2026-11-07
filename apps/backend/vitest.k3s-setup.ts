import type { TestProject } from 'vitest/node';
import { startK3s } from './src/infrastructure/testing/real-k3s.js';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const k3s = await startK3s();
  project.provide('k3s', { admin: k3s.admin, account: k3s.account });
  return () => k3s.stop();
}
