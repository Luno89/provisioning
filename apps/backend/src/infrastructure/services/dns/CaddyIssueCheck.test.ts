import { describe, expect, it } from 'vitest';
import { recordingProcesses, type Script } from '@koala/engine-core/testing/processes';
import type { ProcessRun } from '@koala/engine-core/processes';
import { checkWildcardIn, STAGING_CA } from '../../lib/dns-issue-check.js';
import { buildCaddyImage, issueWithCaddy, type CaddyIssueRequest } from './CaddyIssueCheck.js';

const ZONE = 'nowrinkles.app';
const request: CaddyIssueRequest = { image: 'koala-caddy-check', zone: ZONE, caddyfile: 'caddy', tlsSnippet: 'tls', envLines: ['TOKEN=sekrit'], secrets: ['sekrit'] };
const staging = JSON.stringify({ apps: { tls: { automation: { policies: [{ subjects: [checkWildcardIn(ZONE)], issuers: [{ module: 'acme', ca: STAGING_CA }] }] } } } });
const elsewhere = JSON.stringify({ apps: { tls: { automation: { policies: [{ subjects: [checkWildcardIn(ZONE)], issuers: [{ module: 'acme', ca: 'https://acme-v02.api.letsencrypt.org/directory' }] }] } } } });

const step = (run: ProcessRun): string | undefined => (run.command === 'docker' ? (run.args.includes('adapt') ? 'adapt' : run.args[0]) : undefined);

const docker = (answers: { adapt?: string; caddy?: Script; rm?: Script }) => recordingProcesses((run) => {
  const which = step(run);
  if (which === 'adapt') return { stdout: answers.adapt ?? staging };
  if (which === 'run') return answers.caddy ? answers.caddy(run) : { code: 1 };
  if (which === 'rm') return answers.rm ? answers.rm(run) : { stderr: 'Error response from daemon: No such container\n', code: 1 };
  if (which === 'build') return {};
  return undefined;
});

describe('asking Caddy for a staging certificate', () => {
  it('refuses before asking anyone when Caddy would ask anything but staging, and removes what it made', async () => {
    const processes = docker({ adapt: elsewhere });
    const result = await issueWithCaddy(request, processes);
    expect(result.obtained).toBe(false);
    expect(result.why).toMatch(/^refused before asking anyone: .*not Let's Encrypt's staging/);
    expect(processes.ran.map(step)).toEqual(['adapt', 'rm']);
  });

  it('says why Caddy could not get the certificate, and that its log named a credential, without showing it', async () => {
    const failed = JSON.stringify({ level: 'error', msg: 'could not get certificate from issuer', identifier: checkWildcardIn(ZONE), error: 'TOKEN sekrit refused' });
    const processes = docker({ caddy: () => ({ stderr: `${failed}\n`, runsUntilStopped: true }) });
    const result = await issueWithCaddy(request, processes);
    expect(result).toMatchObject({ obtained: false, why: 'TOKEN [hidden] refused', logNamedSecret: true });
    const caddy = processes.ran.find((run) => step(run) === 'run');
    expect(caddy?.input).toBe('TOKEN=sekrit\n\n');
  });

  it('says Caddy stopped before it had a certificate, with its last lines', async () => {
    const result = await issueWithCaddy(request, docker({ caddy: () => ({ stdout: 'starting\nbye', code: 1 }) }));
    expect(result).toMatchObject({ obtained: false, why: 'Caddy stopped (exit 1) before it had a certificate; its last lines:\nstarting\nbye' });
  });

  it('says docker could not start Caddy when docker is not there', async () => {
    const processes = recordingProcesses((run) => (step(run) === 'adapt' ? { stdout: staging } : step(run) === 'rm' ? {} : undefined));
    expect(await issueWithCaddy(request, processes)).toMatchObject({ obtained: false, why: 'docker could not start Caddy: spawn docker ENOENT' });
  });

  it('fails the check, naming the container, when its container could not be removed', async () => {
    const processes = docker({ adapt: elsewhere, rm: () => ({ stderr: 'Cannot connect to the Docker daemon\n', code: 1 }) });
    await expect(issueWithCaddy(request, processes)).rejects.toThrow(/koala-dns-issue-check-nowrinkles-app-\d+ could not be removed: Cannot connect to the Docker daemon/);
  });

  it('builds the image quietly from its folder', async () => {
    const processes = docker({});
    await buildCaddyImage('koala-caddy-check', '/context', processes);
    expect(processes.ran.map((run) => [run.command, ...run.args])).toEqual([['docker', 'build', '-q', '-t', 'koala-caddy-check', '/context']]);
  });
});
