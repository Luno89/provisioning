import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { localCommands, runSteps } from '@koala/provision';
import { memoryReporter } from '@koala/provision/testing';
import { startTestTemporal } from '@koala/engine-core/testing/temporal';
import { temporalTlsStep } from './src/platform/wiring/root-services.js';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const dir = mkdtempSync(join(tmpdir(), 'koala-test-temporal-tls-'));
  await runSteps([temporalTlsStep(dir)], { commands: localCommands(process.env) }, memoryReporter());
  const server = await startTestTemporal({ key: readFileSync(join(dir, 'server.key'), 'utf8'), cert: readFileSync(join(dir, 'server.crt'), 'utf8') });
  project.provide('temporalAddress', server.address);
  project.provide('temporalTlsAddress', server.tlsAddress);
  project.provide('temporalCa', join(dir, 'ca.crt'));
  return async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  };
}
