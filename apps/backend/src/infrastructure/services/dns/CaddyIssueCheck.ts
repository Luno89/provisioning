import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import {
  caddyEvent, certificatePathIn, namesFromSubjectAltName, stagingOnlyProblem, withoutSecrets, type IssuedCertificate,
} from '../../lib/dns-issue-check.js';
import { ProcessNotStarted, type Processes, type Streams } from '@koala/engine-core/processes';
import { lineSplitter } from '@koala/provision';
import { nodeProcesses, nodeRunner, DOCKER_CLIENT, passedOn, succeeded } from '../../../platform/index.js';


export interface CaddyIssueRequest {
  image: string;
  zone: string;
  caddyfile: string;
  tlsSnippet: string;
  envLines: readonly string[];
  secrets: readonly string[];
}

export interface CaddyIssueResult {
  obtained: boolean;
  why?: string | undefined;
  issuer?: string | undefined;
  certificate?: IssuedCertificate | undefined;
  cleanupErrors: string[];
  logNamedSecret: boolean;
}

const dockerEnv = (): Record<string, string> => passedOn(DOCKER_CLIENT);

const NO_SUCH_CONTAINER = /No such container/i;

const READ_ENV_THEN_RUN = 'while IFS= read -r line && [ -n "$line" ]; do export "$line"; done; exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile';

export async function buildCaddyImage(image: string, context: string, processes: Processes = nodeProcesses): Promise<void> {
  await succeeded(processes, { command: 'docker', args: ['build', '-q', '-t', image, context], env: dockerEnv() });
}

export async function issueWithCaddy(request: CaddyIssueRequest, docker: Processes & Streams = nodeRunner): Promise<CaddyIssueResult> {
  const folder = mkdtempSync(join(tmpdir(), 'koala-dns-issue-check-'));
  const container = `koala-dns-issue-check-${request.zone.replace(/[^a-z0-9]/gi, '-')}-${process.pid}`;
  let caddy: { stop(): void } | undefined;
  const removeAll = async (): Promise<void> => {
    const removed = await docker.run({ command: 'docker', args: ['rm', '-f', container], env: dockerEnv() });
    caddy?.stop();
    rmSync(folder, { recursive: true, force: true });
    if (removed.code !== 0 && !NO_SUCH_CONTAINER.test(removed.stderr)) throw new Error(`the check's container ${container} could not be removed: ${removed.stderr.trim()}`);
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    const exit = (): never => process.exit(signal === 'SIGINT' ? 130 : 143);
    removeAll().then(exit, (err: unknown) => {
      console.error((err as Error).message);
      exit();
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    for (const part of ['data', 'config', 'tls']) mkdirSync(join(folder, part), { mode: 0o700 });
    writeFileSync(join(folder, 'Caddyfile'), request.caddyfile);
    writeFileSync(join(folder, 'tls', 'koala.caddy'), request.tlsSnippet);
    const user = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
    const mounts = [
      '-v', `${join(folder, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`,
      '-v', `${join(folder, 'tls')}:/etc/caddy/tls:ro`,
      '-v', `${join(folder, 'data')}:/data`,
      '-v', `${join(folder, 'config')}:/config`,
    ];

    const adapted = await succeeded(docker, { command: 'docker', args: ['run', '--rm', '--user', user, ...mounts, request.image, 'caddy', 'adapt', '--config', '/etc/caddy/Caddyfile'], env: dockerEnv() });
    const problem = stagingOnlyProblem(JSON.parse(adapted) as Parameters<typeof stagingOnlyProblem>[0], request.zone);
    if (problem) return { obtained: false, why: `refused before asking anyone: ${problem}`, cleanupErrors: [], logNamedSecret: false };

    const outcome = await new Promise<{ obtained: boolean; why?: string; issuer?: string; cleanupErrors: string[]; logNamedSecret: boolean }>((resolve) => {
      const cleanupErrors: string[] = [];
      const tail: string[] = [];
      let logNamedSecret = false;
      let settled = false;
      const settle = (result: { obtained: boolean; why?: string; issuer?: string }): void => {
        if (settled) return;
        settled = true;
        resolve({ ...result, cleanupErrors, logNamedSecret });
      };
      const hear = (line: string): void => {
        if (request.secrets.some((secret) => line.includes(secret))) logNamedSecret = true;
        const said = withoutSecrets(line, request.secrets);
        tail.push(said);
        if (tail.length > 20) tail.shift();
        const event = caddyEvent(said, request.zone);
        if (!event) return;
        if (event.kind === 'obtained') settle({ obtained: true, issuer: event.issuer });
        else if (event.kind === 'attempt-failed') settle({ obtained: false, why: event.error });
        else if (event.kind === 'cleanup-failed') cleanupErrors.push(event.error);
      };
      const out = lineSplitter(hear);
      const err = lineSplitter(hear);
      const running = docker.start({
        command: 'docker',
        args: [
          'run', '-i', '--rm', '--name', container, '--user', user,
          '--sysctl', 'net.ipv4.ip_unprivileged_port_start=0',
          ...mounts, '--entrypoint', 'sh', request.image, '-c', READ_ENV_THEN_RUN,
        ],
        env: dockerEnv(),
      }, { input: `${request.envLines.join('\n')}\n\n`, heard: { stdout: (chunk) => out.push(chunk), stderr: (chunk) => err.push(chunk) } });
      caddy = running;
      running.ended.then(
        (ended) => {
          out.end();
          err.end();
          settle({ obtained: false, why: `Caddy stopped (exit ${ended.signal ?? ended.code}) before it had a certificate; its last lines:\n${tail.join('\n')}` });
        },
        (error: unknown) => settle({ obtained: false, why: `docker could not start Caddy: ${error instanceof ProcessNotStarted ? error.reason : (error as Error).message}` }),
      );
    });

    if (!outcome.obtained) return outcome;
    const pem = readFileSync(join(folder, 'data', certificatePathIn(request.zone)), 'utf8');
    const leaf = new X509Certificate(pem);
    const certificate: IssuedCertificate = {
      names: namesFromSubjectAltName(leaf.subjectAltName),
      issuer: leaf.issuer.replace(/\n/g, ', '),
      validFrom: new Date(leaf.validFrom),
      validTo: new Date(leaf.validTo),
    };
    return { ...outcome, certificate };
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await removeAll();
  }
}
