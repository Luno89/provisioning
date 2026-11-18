import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import tls from 'node:tls';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import type { TestProject } from 'vitest/node';
import { OWNER_ATTRIBUTE } from './src/platform/lib/workflow-owner.js';

const TEMPORAL_TLS_SCRIPT = resolve(__dirname, '../../scripts/temporal-tls.sh');

function tlsInFrontOf(address: string, dir: string): Promise<tls.Server> {
  const [host, port] = [address.slice(0, address.lastIndexOf(':')), Number(address.slice(address.lastIndexOf(':') + 1))];
  const server = tls.createServer({ key: readFileSync(join(dir, 'server.key')), cert: readFileSync(join(dir, 'server.crt')), ALPNProtocols: ['h2'] }, (secured) => {
    const plain = net.connect(port, host === 'localhost' ? '127.0.0.1' : host);
    secured.pipe(plain).pipe(secured);
    const end = (): void => { secured.destroy(); plain.destroy(); };
    secured.on('error', end);
    plain.on('error', end);
    secured.on('close', end);
    plain.on('close', end);
  });
  return new Promise((ready) => server.listen(0, '127.0.0.1', () => ready(server)));
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const env = await TestWorkflowEnvironment.createLocal({
    server: { searchAttributes: [OWNER_ATTRIBUTE] },
  });
  const dir = mkdtempSync(join(tmpdir(), 'koala-test-temporal-tls-'));
  execFileSync('bash', [TEMPORAL_TLS_SCRIPT, dir], { stdio: ['ignore', 'ignore', 'pipe'] });
  const front = await tlsInFrontOf(env.address, dir);
  project.provide('temporalAddress', env.address);
  project.provide('temporalTlsAddress', `127.0.0.1:${(front.address() as net.AddressInfo).port}`);
  project.provide('temporalCa', join(dir, 'ca.crt'));
  return async () => {
    await new Promise<void>((done) => front.close(() => done()));
    await env.teardown();
    rmSync(dir, { recursive: true, force: true });
  };
}
