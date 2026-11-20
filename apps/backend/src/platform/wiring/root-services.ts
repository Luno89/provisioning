import { chmod, chown, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import type { Connection } from '@temporalio/client';
import { connectTemporal } from '@koala/engine-core/temporal';
import { composeProvider, composeStep, serviceStep, type ComposeContext, type ComposeProject, type Provider, type ServiceContext, type Step, type StepState } from '@koala/provision';
import { mongoClientFor } from '../lib/collection.js';
import { answerFailure, failureOf, stillDown } from '../lib/dependencies.js';
import { replicaSetProblem } from '../lib/replica-set.js';
import { temporalJwks } from '../lib/temporal-auth.js';
import { temporalDial } from '../lib/temporal-connection.js';
import { answersHttp } from './dependencies.js';

export const ROOT_SERVICE_NAMES = ['temporal-keys', 'temporal', 'mongo', 'headscale', 'registry', 'caddy'] as const;
export type RootServiceName = typeof ROOT_SERVICE_NAMES[number];

export interface FilesOwner {
  uid: number;
  gid: number;
}

export interface RootServices {
  program: ComposeProject['program'];
  project?: string;
  tlsOwner?: FilesOwner;
  temporal: { files: string[]; address: string; namespace: string; tlsDir: string; jwksFile: string; key: () => string };
  mongo: { files: string[]; address: string };
  headscale: { files: string[]; url: string };
  registry: { files: string[]; push: string };
  caddy: { files: string[]; admin: CaddyAdmin };
}

export type CaddyAdmin = { socket: string } | { url: string };

export type RootServicePlaces = Omit<RootServices, 'program' | 'tlsOwner' | 'temporal'> & { temporal: Omit<RootServices['temporal'], 'key'> };

export function rootServicesIn(repo: string): RootServicePlaces {
  return {
    temporal: {
      files: [join(repo, 'docker-compose.temporal.yml')],
      address: '127.0.0.1:7233',
      namespace: 'default',
      tlsDir: join(repo, 'apps/backend/data/temporal-tls'),
      jwksFile: join(repo, 'apps/backend/data/temporal-keys/temporal-jwks.json'),
    },
    mongo: { files: [join(repo, 'docker-compose.mongo.yml')], address: '127.0.0.1:27017' },
    headscale: { files: [join(repo, 'docker-compose.headscale.yml')], url: 'http://127.0.0.1:8080' },
    registry: { files: [join(repo, 'docker-compose.registry.yml')], push: '127.0.0.1:5000' },
    caddy: { files: [join(repo, 'docker-compose.caddy.yml')], admin: { socket: '/run/koala-caddy/admin.sock' } },
  };
}

export function rootServicesAt(places: RootServicePlaces, program: ComposeProject['program'], temporalKey: () => string, tlsOwner?: FilesOwner): RootServices {
  return { ...places, program, temporal: { ...places.temporal, key: temporalKey }, ...(tlsOwner ? { tlsOwner } : {}) };
}

const TLS_FILES = ['ca.crt', 'server.crt', 'server.key'] as const;
const SERVER_EXTENSIONS = 'subjectAltName=DNS:localhost,DNS:temporal,DNS:host.k3d.internal,DNS:host.docker.internal,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature\n';

async function sizeOf(path: string): Promise<{ size: number; uid: number } | undefined> {
  try {
    return await stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function tlsMissing(dir: string): Promise<string | undefined> {
  for (const file of TLS_FILES) {
    const found = await sizeOf(join(dir, file));
    if (!found || found.size === 0) return join(dir, file);
  }
  return undefined;
}

export function temporalTlsStep(dir: string, owner?: FilesOwner): Step<ComposeContext> {
  return {
    id: 'temporal-tls',
    title: 'Temporal\'s certificate, signed by a CA of its own',
    async check() {
      const missing = await tlsMissing(dir);
      if (missing) return { done: false, why: `${missing} is not there` };
      if (owner) {
        for (const file of ['', ...TLS_FILES]) {
          const found = await stat(join(dir, file));
          if (found.uid !== owner.uid) return { done: false, why: `${join(dir, file)} is not owned by ${owner.uid}, whom Temporal runs as` };
        }
      }
      return { done: true };
    },
    async apply(ctx, progress) {
      if (await tlsMissing(dir)) {
        await mkdir(dir, { recursive: true });
        await chmod(dir, 0o755);
        const work = await mkdtemp(join(tmpdir(), 'koala-temporal-tls-'));
        try {
          const openssl = (args: string[]) => ctx.commands.run({ command: 'openssl', args }, progress);
          await openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', join(work, 'ca.key')]);
          await openssl(['req', '-x509', '-new', '-key', join(work, 'ca.key'), '-sha256', '-days', '3650', '-subj', '/CN=Koala Temporal CA', '-out', join(dir, 'ca.crt')]);
          await openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', join(dir, 'server.key')]);
          await openssl(['req', '-new', '-key', join(dir, 'server.key'), '-subj', '/CN=temporal', '-out', join(work, 'server.csr')]);
          await writeFile(join(work, 'ext'), SERVER_EXTENSIONS);
          await openssl(['x509', '-req', '-in', join(work, 'server.csr'), '-CA', join(dir, 'ca.crt'), '-CAkey', join(work, 'ca.key'), '-CAcreateserial', '-CAserial', join(work, 'ca.srl'), '-days', '3650', '-sha256', '-extfile', join(work, 'ext'), '-out', join(dir, 'server.crt')]);
          await chmod(join(dir, 'ca.crt'), 0o644);
          await chmod(join(dir, 'server.crt'), 0o644);
          await chmod(join(dir, 'server.key'), 0o600);
          progress.line(`made Temporal's certificate, signed by a CA of its own, in ${dir}`);
        } finally {
          await rm(work, { recursive: true, force: true });
        }
      }
      if (owner) {
        for (const file of ['', ...TLS_FILES]) await chown(join(dir, file), owner.uid, owner.gid);
      }
    },
  };
}

export const temporalJwksText = (key: string): string => `${JSON.stringify(temporalJwks(key))}\n`;

export async function writeTemporalJwks(target: string, key: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(`${target}.new`, temporalJwksText(key), { mode: 0o644 });
  await chmod(`${target}.new`, 0o644);
  await rename(`${target}.new`, target);
}

export function temporalJwksStep(target: string, key: () => string): Step<ComposeContext> {
  return {
    id: 'temporal-jwks',
    title: 'The key Temporal checks Koala\'s tokens with',
    async check() {
      const found = await sizeOf(target);
      if (!found) return { done: false, why: `${target} is not there` };
      if (await readFile(target, 'utf8') !== temporalJwksText(key())) return { done: false, why: `${target} holds another key than the platform's Temporal key` };
      return { done: true };
    },
    async apply(_ctx, progress) {
      await writeTemporalJwks(target, key());
      progress.line(`Temporal reads Koala's public key from ${target}`);
    },
  };
}

const project = (services: RootServices, files: string[]): ComposeProject => ({
  program: services.program,
  files,
  ...(services.project !== undefined ? { project: services.project } : {}),
});

function handshake(address: string, ca: Buffer): Promise<void> {
  const split = address.lastIndexOf(':');
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: address.slice(0, split), port: Number(address.slice(split + 1)), ca, ALPNProtocols: ['h2'] }, () => {
      socket.end();
      resolve();
    });
    socket.once('error', reject);
  });
}

async function whyNotConnected(address: string, ca: Buffer, err: unknown): Promise<Error> {
  const connecting = failureOf(err);
  if (connecting.kind === 'final') return err instanceof Error ? err : new Error(String(err));
  try {
    await handshake(address, ca);
  } catch (refused) {
    const handshaking = failureOf(refused);
    return handshaking.kind === 'final' ? new Error(`Temporal's certificate is refused: ${handshaking.reason}`) : stillDown(`it takes no connections yet: ${handshaking.reason}`);
  }
  return stillDown(`its TLS handshake completes, but its gRPC connection did not open yet: ${connecting.reason}`);
}

export function temporalAnswers(temporal: RootServices['temporal']): () => Promise<StepState> {
  return async () => {
    const dial = temporalDial('koala-root-services', { temporal: { address: temporal.address, namespace: temporal.namespace, caPath: join(temporal.tlsDir, 'ca.crt') }, keys: { temporal: temporal.key() } }, 'read');
    let connection: Connection;
    try {
      connection = await connectTemporal(dial, 'client');
    } catch (err) {
      throw await whyNotConnected(temporal.address, Buffer.from(dial.tls.ca), err);
    }
    try {
      await connection.workflowService.getSystemInfo({});
      return { done: true };
    } finally {
      await connection.close();
    }
  };
}

export function mongoAnswers(address: () => string): () => Promise<StepState> {
  return async () => {
    const client = mongoClientFor(`mongodb://${address()}/`);
    try {
      const problem = await replicaSetProblem(client);
      return problem ? { done: false, why: problem } : { done: true };
    } finally {
      await client.close();
    }
  };
}

function adminStatus(admin: CaddyAdmin): Promise<number> {
  if ('url' in admin) return fetch(`${admin.url}/config/`).then((answer) => answer.status);
  return new Promise((done, failed) => {
    const asked = request({ socketPath: admin.socket, path: '/config/', method: 'GET' }, (answer) => {
      answer.resume();
      done(answer.statusCode ?? 0);
    });
    asked.once('error', failed);
    asked.end();
  });
}

export function caddyAnswers(admin: CaddyAdmin): () => Promise<StepState> {
  return async () => {
    const status = await adminStatus(admin);
    if (status !== 200) throw answerFailure(status, null);
    return { done: true };
  };
}

export function caddyStep<Context extends ServiceContext>(provider: Provider<Context>, admin: () => CaddyAdmin): Step<Context> {
  return serviceStep({ id: 'caddy', title: 'Caddy, answering on its admin API', provider, answers: () => caddyAnswers(admin())() });
}

export const MONGO_TITLE = 'Mongo, as a replica set';

export function mongoStep<Context extends ServiceContext>(provider: Provider<Context>, address: () => string): Step<Context> {
  return serviceStep({ id: 'mongo', title: MONGO_TITLE, provider, answers: mongoAnswers(address) });
}

export function httpAnswers(url: string): () => Promise<StepState> {
  return async () => {
    await answersHttp(url)();
    return { done: true };
  };
}

function stepsOf(services: RootServices, name: RootServiceName): Step<ComposeContext>[] {
  const keys = [temporalTlsStep(services.temporal.tlsDir, services.tlsOwner), temporalJwksStep(services.temporal.jwksFile, services.temporal.key)];
  switch (name) {
    case 'temporal-keys':
      return keys;
    case 'temporal':
      return [...keys, composeStep({ id: 'temporal', title: 'Temporal, answering over TLS', compose: project(services, services.temporal.files), answers: temporalAnswers(services.temporal) })];
    case 'mongo':
      return [mongoStep(composeProvider(MONGO_TITLE, project(services, services.mongo.files)), () => services.mongo.address)];
    case 'headscale':
      return [composeStep({ id: 'headscale', title: 'Headscale, the mesh\'s coordination server', compose: project(services, services.headscale.files), answers: httpAnswers(`${services.headscale.url}/health`) })];
    case 'caddy':
      return [caddyStep(composeProvider('Caddy', { ...project(services, services.caddy.files), build: true }), () => services.caddy.admin)];
    case 'registry':
      return [composeStep({ id: 'registry', title: 'The image registry for instances', compose: project(services, services.registry.files), answers: httpAnswers(`http://${services.registry.push}/v2/`) })];
  }
}

export function rootServiceSteps(services: RootServices, names: readonly RootServiceName[]): Step<ComposeContext>[] {
  const steps = names.flatMap((name) => stepsOf(services, name));
  return steps.filter((step, at) => steps.findIndex((other) => other.id === step.id) === at);
}

const USAGE = `usage: root-services.ts --compose <compose program> <${ROOT_SERVICE_NAMES.join('|')}>...`;

const isServiceName = (name: string): name is RootServiceName => (ROOT_SERVICE_NAMES as readonly string[]).includes(name);

export function rootServicesAsked(argv: readonly string[]): { program: ComposeProject['program']; names: RootServiceName[] } {
  const at = argv.indexOf('--compose');
  const words = at >= 0 ? (argv[at + 1] ?? '').split(' ').filter((word) => word !== '') : [];
  const [first, ...rest] = words;
  if (first === undefined) throw new Error(`name the compose program to run them with; ${USAGE}`);
  const names = argv.filter((_arg, index) => index !== at && index !== at + 1);
  if (names.length === 0) throw new Error(`name at least one service; ${USAGE}`);
  const unknown = names.find((name) => !isServiceName(name));
  if (unknown !== undefined) throw new Error(`${unknown} is not one of root's services; ${USAGE}`);
  return { program: [first, ...rest], names: names.filter(isServiceName) };
}
