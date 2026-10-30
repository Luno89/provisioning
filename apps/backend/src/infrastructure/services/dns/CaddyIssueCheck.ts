import { execFile, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { X509Certificate } from 'node:crypto';
import {
  caddyEvent, certificatePathIn, namesFromSubjectAltName, stagingOnlyProblem, withoutSecrets, type IssuedCertificate,
} from '../../lib/dns-issue-check.js';

const run = promisify(execFile);

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

const READ_ENV_THEN_RUN = 'while IFS= read -r line && [ -n "$line" ]; do export "$line"; done; exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile';

export async function buildCaddyImage(image: string, context: string): Promise<void> {
  await run('docker', ['build', '-q', '-t', image, context], { maxBuffer: 64 * 1024 * 1024 });
}

export async function issueWithCaddy(request: CaddyIssueRequest): Promise<CaddyIssueResult> {
  const folder = mkdtempSync(join(tmpdir(), 'koala-dns-issue-check-'));
  const container = `koala-dns-issue-check-${request.zone.replace(/[^a-z0-9]/gi, '-')}-${process.pid}`;
  const removeAll = (): void => {
    spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
    rmSync(folder, { recursive: true, force: true });
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    removeAll();
    process.exit(signal === 'SIGINT' ? 130 : 143);
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

    const adapted = await run('docker', ['run', '--rm', '--user', user, ...mounts, request.image, 'caddy', 'adapt', '--config', '/etc/caddy/Caddyfile'], { maxBuffer: 16 * 1024 * 1024 });
    const problem = stagingOnlyProblem(JSON.parse(adapted.stdout) as Parameters<typeof stagingOnlyProblem>[0], request.zone);
    if (problem) return { obtained: false, why: `refused before asking anyone: ${problem}`, cleanupErrors: [], logNamedSecret: false };

    const outcome = await new Promise<{ obtained: boolean; why?: string; issuer?: string; cleanupErrors: string[]; logNamedSecret: boolean }>((resolve) => {
      const child = spawn('docker', [
        'run', '-i', '--rm', '--name', container, '--user', user,
        '--sysctl', 'net.ipv4.ip_unprivileged_port_start=0',
        ...mounts, '--entrypoint', 'sh', request.image, '-c', READ_ENV_THEN_RUN,
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
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
      createInterface({ input: child.stdout }).on('line', hear);
      createInterface({ input: child.stderr }).on('line', hear);
      child.on('error', (error) => settle({ obtained: false, why: `docker could not start Caddy: ${error.message}` }));
      child.on('exit', (code) => settle({ obtained: false, why: `Caddy stopped (exit ${code ?? 'signal'}) before it had a certificate; its last lines:\n${tail.join('\n')}` }));
      child.stdin.end(`${request.envLines.join('\n')}\n\n`);
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
    removeAll();
  }
}
