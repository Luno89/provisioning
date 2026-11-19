import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { composeStep, runSteps, StepFailed } from '@koala/provision';
import { fakeCommands, memoryReporter } from '@koala/provision/testing';
import { portToHandOn } from '@koala/engine-core/testing/ports';
import { temporalAnswers, type RootServices } from './root-services.js';

const KEY = 'k'.repeat(64);
let folder = '';
const closing: Array<() => Promise<void>> = [];

const openssl = (...args: string[]): void => { execFileSync('openssl', args, { stdio: 'ignore' }); };
const at = (name: string): string => join(folder, name);

function authority(name: string): void {
  openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', `/CN=${name}`, '-keyout', at(`${name}.key`), '-out', at(`${name}.crt`));
}

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'koala-temporal-answers-'));
  mkdirSync(at('tls'));
  authority('own-ca');
  authority('other-ca');
  writeFileSync(at('ext'), 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
  openssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-subj', '/CN=temporal', '-keyout', at('server.key'), '-out', at('server.csr'));
  openssl('x509', '-req', '-in', at('server.csr'), '-CA', at('own-ca.crt'), '-CAkey', at('own-ca.key'), '-CAcreateserial', '-CAserial', at('own-ca.srl'), '-days', '1', '-extfile', at('ext'), '-out', at('server.crt'));
  writeFileSync(at('tls/ca.crt'), readFileSync(at('own-ca.crt')));
});

afterEach(async () => {
  for (const close of closing.splice(0)) await close();
});

afterAll(() => { rmSync(folder, { recursive: true, force: true }); });

const temporalOn = (port: number): RootServices['temporal'] => ({ files: ['/repo/docker-compose.temporal.yml'], address: `127.0.0.1:${port}`, namespace: 'default', tlsDir: at('tls'), jwksFile: at('jwks.json'), key: () => KEY });

const running = () => fakeCommands((command) => {
  const args = command.args ?? [];
  if (args.includes('config')) return { stdout: 'temporal t\n' };
  if (args.includes('ps')) return { stdout: 'temporal\trunning\t0\tt\n' };
  if (args.includes('up')) return {};
  return undefined;
});

async function listening(server: tls.Server | http2.Http2SecureServer, port = 0): Promise<number> {
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  closing.push(() => new Promise((resolve) => { server.close(() => resolve()); }));
  return (server.address() as AddressInfo).port;
}

function systemInfoServer(): http2.Http2SecureServer {
  const server = http2.createSecureServer({ key: readFileSync(at('server.key')), cert: readFileSync(at('server.crt')) });
  server.on('stream', (stream, headers) => {
    if (headers[':path'] !== '/temporal.api.workflowservice.v1.WorkflowService/GetSystemInfo') {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '12' }, { endStream: true });
      return;
    }
    stream.on('data', () => undefined);
    stream.on('end', () => {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => { stream.sendTrailers({ 'grpc-status': '0' }); });
      stream.end(Buffer.alloc(5));
    });
  });
  return server;
}

const ended = async (run: Promise<void>): Promise<StepFailed> => {
  const err: unknown = await run.then(() => undefined, (thrown: unknown) => thrown);
  if (!(err instanceof StepFailed)) throw new Error(`expected StepFailed, the run ended with ${String(err)}`);
  return err;
};

describe('whether Temporal answers over TLS to its own CA', () => {
  it('fails at once, saying why, when the server on its address shows a certificate another CA signed', async () => {
    const port = await listening(tls.createServer({ key: readFileSync(at('other-ca.key')), cert: readFileSync(at('other-ca.crt')) }));
    const failure = await ended(runSteps([composeStep({ id: 'temporal', title: 'Temporal', compose: { program: ['docker', 'compose'], files: [] }, answers: temporalAnswers(temporalOn(port)) })], { commands: running(), wait: { pause: async () => undefined } }, memoryReporter()));
    expect(failure.why).toContain('Temporal\'s certificate is refused');
    expect(failure.why).toContain('self-signed certificate');
  });

  it('waits while its port is not open yet, and ends answered once it opens', async () => {
    const port = await portToHandOn();
    let opened = false;
    const pause = async (): Promise<void> => {
      if (opened) return;
      opened = true;
      await listening(systemInfoServer(), port);
    };
    const reporter = memoryReporter();
    await runSteps([composeStep({ id: 'temporal', title: 'Temporal', compose: { program: ['docker', 'compose'], files: [] }, answers: temporalAnswers(temporalOn(port)) })], { commands: running(), wait: { pause } }, reporter);
    expect(opened).toBe(true);
    expect(reporter.reported.at(-1)).toEqual({ kind: 'done', id: 'temporal' });
  });
});
