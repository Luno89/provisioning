import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  existingOnCluster, orphanedIngressWebhook, PLATFORM_KINDS, PLATFORM_PLAN, platformSecretManifests, platformStackEnv, platformStackName, secretStamp,
  type PlatformServicePlan, type Reach, type SecretSource, type SecretValues,
} from '../infrastructure/index.js';
import type { ClusterSteps } from './cluster-steps.js';
import { applyWatched, untilRolledOut, type Pause } from './watched-apply.js';

export interface PlatformPlace {
  reach: Reach;
  koalaNamespace: string;
  pool: boolean;
  dataDir: string;
  crawl4aiToken: string;
  qdrantApiKey: string;
}

type Steps = Pick<ClusterSteps, 'access' | 'infra'>;

async function kept(place: PlatformPlace, service: PlatformServicePlan, key: string, source: Extract<SecretSource, { file: string }>): Promise<string> {
  const file = path.join(place.dataDir, source.file);
  const stored = await fs.readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  });
  if (stored !== undefined) {
    const value = stored.trim();
    if (!value) throw new Error(`${file} is empty; ${service.what}'s secret ${key} was kept there, and a new one would not open what the old one sealed`);
    return value;
  }
  const made = randomBytes(source.make.bytes).toString(source.make.as);
  await fs.writeFile(file, made, { mode: 0o600, flag: 'wx' });
  return made;
}

async function valueOf(place: PlatformPlace, service: PlatformServicePlan, key: string, source: SecretSource): Promise<string> {
  if ('text' in source) return source.text;
  if ('setting' in source) return place[source.setting];
  return kept(place, service, key, source);
}

async function secretValues(place: PlatformPlace, service: PlatformServicePlan): Promise<SecretValues> {
  const values: SecretValues = {};
  for (const secret of service.secrets) {
    const each: Record<string, string> = {};
    for (const [key, source] of Object.entries(secret.values)) each[key] = await valueOf(place, service, key, source);
    values[secret.name] = each;
  }
  return values;
}

async function alreadyThere(steps: Steps, reach: Reach, service: PlatformServicePlan): Promise<string[]> {
  const namespaces: unknown = JSON.parse(await steps.access.kubectl(reach, ['get', 'namespaces', '-o', 'json']));
  const objects = await Promise.all(service.namespaces.map(async (namespace) => JSON.parse(await steps.access.kubectl(reach, ['get', PLATFORM_KINDS, '-n', namespace, '-o', 'json'])) as unknown));
  const releases = await Promise.all(service.namespaces.map(async (namespace) => JSON.parse(await steps.access.helm(reach, ['list', '-n', namespace, '-a', '-o', 'json'])) as []));
  return existingOnCluster(service.namespaces, namespaces, objects, releases);
}

export async function provisionPlatformService(steps: Steps, place: PlatformPlace, service: PlatformServicePlan, report: (line: string) => void, wait?: Pause): Promise<void> {
  const logFile = steps.infra.getLogPath(platformStackName(service.key));
  report(`${service.what}: applying; Terraform writes to ${logFile}`);
  if (service.checkIngressWebhook) {
    const orphaned = orphanedIngressWebhook(JSON.parse(await steps.access.kubectl(place.reach, ['get', 'validatingwebhookconfigurations', '-o', 'json'])));
    if (orphaned) throw new Error(`${service.what} cannot be applied: ${orphaned}`);
  }
  const values = await secretValues(place, service);
  for (const manifest of platformSecretManifests(service, values)) await steps.access.apply(place.reach, JSON.stringify(manifest));
  const env = platformStackEnv({
    service: service.key,
    kubeconfigPath: await steps.access.kubeconfigOf(place.reach),
    existing: await alreadyThere(steps, place.reach, service),
    koalaNamespace: place.koalaNamespace,
    pool: place.pool,
    stamp: secretStamp(values),
  });
  const watched = { what: service.what, reach: place.reach, namespaces: service.watch, log: report };
  await applyWatched(steps, platformStackName(service.key), { env, logFile }, watched, wait);
  await untilRolledOut(steps, watched, wait);
  report(`${service.what}: ready`);
}

export async function provisionPlatformServices(steps: Steps, place: PlatformPlace, report: (line: string) => void, wait?: Pause): Promise<void> {
  for (const service of PLATFORM_PLAN) await provisionPlatformService(steps, place, service, report, wait);
}
