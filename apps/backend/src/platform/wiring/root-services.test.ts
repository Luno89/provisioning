import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSteps, type Command } from '@koala/provision';
import { fakeCommands, memoryReporter } from '@koala/provision/testing';
import { temporalJwks } from '../lib/temporal-auth.js';
import { ROOT_SERVICE_NAMES, rootServicesAsked, rootServiceSteps, rootServicesIn, temporalJwksStep, temporalTlsStep } from './root-services.js';

const KEY = 'k'.repeat(64);
const folders: string[] = [];
const folder = (): string => {
  const made = mkdtempSync(join(tmpdir(), 'koala-root-services-'));
  folders.push(made);
  return made;
};

afterEach(() => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
});

const extensions: string[] = [];

const openssl = () => fakeCommands((command: Command) => {
  if (command.command !== 'openssl') return undefined;
  const args = command.args ?? [];
  if (args.includes('-extfile')) extensions.push(readFileSync(args[args.indexOf('-extfile') + 1]!, 'utf8'));
  const out = args[args.indexOf('-out') + 1];
  if (out) writeFileSync(out, `made by openssl ${command.args?.[0] ?? ''}\n`);
  return {};
});

describe('root\'s services, as steps', () => {
  it('are the compose files and addresses root runs them at, in this checkout', () => {
    const services = rootServicesIn('/opt/nowrinkles', ['docker', 'compose'], () => KEY);
    expect(services.temporal).toMatchObject({ files: ['/opt/nowrinkles/docker-compose.temporal.yml'], address: '127.0.0.1:7233', namespace: 'default', tlsDir: '/opt/nowrinkles/apps/backend/data/temporal-tls', jwksFile: '/opt/nowrinkles/apps/backend/data/temporal-keys/temporal-jwks.json' });
    expect(services.mongo).toEqual({ files: ['/opt/nowrinkles/docker-compose.mongo.yml'], address: '127.0.0.1:27017' });
    expect(services.headscale).toEqual({ files: ['/opt/nowrinkles/docker-compose.headscale.yml'], url: 'http://127.0.0.1:8080' });
    expect(services.registry).toEqual({ files: ['/opt/nowrinkles/docker-compose.registry.yml'], push: '127.0.0.1:5000' });
  });

  it('are the steps of the services named, in the order named, Temporal\'s keys before Temporal and each step once', () => {
    const services = rootServicesIn('/repo', ['docker', 'compose'], () => KEY);
    expect(rootServiceSteps(services, ['temporal', 'mongo', 'headscale', 'registry']).map((step) => step.id)).toEqual(['temporal-tls', 'temporal-jwks', 'temporal', 'mongo', 'headscale', 'registry']);
    expect(rootServiceSteps(services, ['temporal-keys', 'temporal']).map((step) => step.id)).toEqual(['temporal-tls', 'temporal-jwks', 'temporal']);
    expect(rootServiceSteps(services, ['registry']).map((step) => step.id)).toEqual(['registry']);
    expect(ROOT_SERVICE_NAMES).toEqual(['temporal-keys', 'temporal', 'mongo', 'headscale', 'registry']);
  });
});

describe('what the entry is asked to start', () => {
  it('is the compose program, as dev and the host each run compose, and the services in order', () => {
    expect(rootServicesAsked(['--compose', '/repo/bin/docker-compose', 'temporal', 'mongo'])).toEqual({ program: ['/repo/bin/docker-compose'], names: ['temporal', 'mongo'] });
    expect(rootServicesAsked(['--compose', 'docker compose', 'registry'])).toEqual({ program: ['docker', 'compose'], names: ['registry'] });
  });

  it('refuses a service it does not know, no compose program or no service, saying what it takes', () => {
    const usage = 'usage: root-services.ts --compose <compose program> <temporal-keys|temporal|mongo|headscale|registry>...';
    expect(() => rootServicesAsked(['--compose', 'docker compose', 'caddy'])).toThrow(`caddy is not one of root's services; ${usage}`);
    expect(() => rootServicesAsked(['temporal'])).toThrow(`name the compose program to run them with; ${usage}`);
    expect(() => rootServicesAsked(['--compose', 'docker compose'])).toThrow(`name at least one service; ${usage}`);
  });
});

describe('Temporal\'s certificate', () => {
  it('is made with a CA of its own when it is not there, its key readable only by its owner', async () => {
    const tls = join(folder(), 'temporal-tls');
    const commands = openssl();
    const reporter = memoryReporter();
    await runSteps([temporalTlsStep(tls)], { commands }, reporter);
    expect(commands.ran.map((command) => command.args?.[0])).toEqual(['ecparam', 'req', 'ecparam', 'req', 'x509']);
    expect(commands.ran[1]?.args).toEqual(expect.arrayContaining(['-x509', '-subj', '/CN=Koala Temporal CA', '-out', join(tls, 'ca.crt')]));
    expect(extensions.at(-1)).toBe('subjectAltName=DNS:localhost,DNS:temporal,DNS:host.k3d.internal,DNS:host.docker.internal,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature\n');
    expect(statSync(join(tls, 'server.key')).mode & 0o777).toBe(0o600);
    expect(statSync(join(tls, 'server.crt')).mode & 0o777).toBe(0o644);
    expect(statSync(join(tls, 'ca.crt')).mode & 0o777).toBe(0o644);
    expect(reporter.reported.at(-1)).toEqual({ kind: 'done', id: 'temporal-tls' });
  });

  it('is kept when it is there, since every Koala process trusts its CA', async () => {
    const tls = folder();
    for (const file of ['ca.crt', 'server.crt', 'server.key']) writeFileSync(join(tls, file), 'kept\n');
    const commands = openssl();
    const reporter = memoryReporter();
    await runSteps([temporalTlsStep(tls)], { commands }, reporter);
    expect(commands.ran).toEqual([]);
    expect(reporter.reported.map((entry) => entry.kind)).toEqual(['started', 'already-done']);
    expect(readFileSync(join(tls, 'ca.crt'), 'utf8')).toBe('kept\n');
  });

  it('is not done while its files are not owned by whom Temporal runs as, and is handed to them without being made again', async () => {
    const tls = folder();
    for (const file of ['ca.crt', 'server.crt', 'server.key']) writeFileSync(join(tls, file), 'kept\n');
    const someoneElse = { uid: process.getuid!() + 1, gid: process.getgid!() };
    expect(await temporalTlsStep(tls, someoneElse).check({ commands: openssl() })).toEqual({ done: false, why: `${join(tls, '')} is not owned by ${someoneElse.uid}, whom Temporal runs as` });
    const commands = openssl();
    await runSteps([temporalTlsStep(tls, { uid: process.getuid!(), gid: process.getgid!() })], { commands }, memoryReporter());
    expect(commands.ran).toEqual([]);
  });

  it('is not there when its key is missing, and says which file is', async () => {
    const tls = folder();
    for (const file of ['ca.crt', 'server.crt']) writeFileSync(join(tls, file), 'kept\n');
    expect(await temporalTlsStep(tls).check({ commands: openssl() })).toEqual({ done: false, why: `${join(tls, 'server.key')} is not there` });
  });
});

describe('the key Temporal checks Koala\'s tokens with', () => {
  it('is written where Temporal reads it, from the platform\'s Temporal key', async () => {
    const target = join(folder(), 'temporal-keys', 'temporal-jwks.json');
    const step = temporalJwksStep(target, () => KEY);
    expect(await step.check({ commands: openssl() })).toEqual({ done: false, why: `${target} is not there` });
    await runSteps([step], { commands: openssl() }, memoryReporter());
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(temporalJwks(KEY));
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });

  it('is written again when it holds another key', async () => {
    const target = join(folder(), 'temporal-jwks.json');
    writeFileSync(target, `${JSON.stringify(temporalJwks('o'.repeat(64)))}\n`);
    expect(await temporalJwksStep(target, () => KEY).check({ commands: openssl() })).toEqual({ done: false, why: `${target} holds another key than the platform's Temporal key` });
  });
});
