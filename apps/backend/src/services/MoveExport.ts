import crypto from 'crypto';
import fs from 'fs/promises';
import { readdirSync } from 'fs';
import path from 'path';
import zlib from 'zlib';
import { spawn as spawnProcess, type ChildProcess } from 'child_process';
import { PassThrough, type Readable } from 'stream';
import { MongoClient } from 'mongodb';
import { exportLines } from '../lib/mongo-move.js';
import { checkMoveToken } from '../lib/identity-token.js';
import { GITEA_DATA, MOVED_POSTGRES, PG_DUMP, keysEnv, type MovePart } from '../lib/instance-move.js';
import {
  COPIED_KINDS, REPLICAS_ANNOTATION, SCALED_KINDS, copied, isMovedNamespace, volumesOf,
  type AppsManifest, type KubeObject, type MovedNamespace,
} from '../lib/app-move.js';

export const MOVING_FILE = '.moving';

export interface MoveExportDeps {
  instanceId: string;
  trusted: ReadonlyMap<string, crypto.KeyObject>;
  dataDir: string;
  mongo: { uri: string; dbName: string };
  env: NodeJS.ProcessEnv;
  running: () => Promise<string[] | 'unknown'>;
  spawn?: typeof spawnProcess;
  now?: () => number;
}

export type MoveRefusal = { status: 401 | 409 | 500 | 503; error: string };

export const VOLUME_HELPER = 'koala-move-volume';
export const SELF_UPGRADE = { name: 'instance-self-upgrade', namespace: 'nowrinkles' } as const;
const HELPER_IMAGE = 'busybox:1.37';

export class MoveExport {
  private frozen = false;

  constructor(private readonly deps: MoveExportDeps) {}

  async load(): Promise<void> {
    this.frozen = await fs.access(path.join(this.deps.dataDir, MOVING_FILE)).then(() => true, () => false);
  }

  isFrozen(): boolean {
    return this.frozen;
  }

  check(token: unknown, part: string): MoveRefusal | undefined {
    const checked = checkMoveToken(typeof token === 'string' ? token : '', this.deps.trusted, this.deps.instanceId, part, this.deps.now ? Math.floor(this.deps.now() / 1000) : undefined);
    return checked.ok ? undefined : { status: 401, error: `root did not ask for this (${checked.reason})` };
  }

  async freeze(): Promise<MoveRefusal | undefined> {
    if (this.frozen) return undefined;
    const running = await this.deps.running();
    if (running === 'unknown') return { status: 503, error: 'the instance is still starting; ask again shortly' };
    if (running.length) return { status: 409, error: `finish or stop what runs first, then start the move again: ${running.join('; ')}` };
    await fs.writeFile(path.join(this.deps.dataDir, MOVING_FILE), new Date().toISOString());
    this.frozen = true;
    await this.selfUpgrade(false).catch(() => undefined);
    return undefined;
  }

  async thaw(): Promise<void> {
    for (const namespace of await this.namespaces().catch(() => [])) {
      for (const kind of SCALED_KINDS) {
        const listed = JSON.parse(await this.kubectl(['get', kind, '-n', namespace, '-o', 'json'])) as { items?: KubeObject[] };
        for (const item of listed.items ?? []) {
          const kept = item.metadata?.annotations?.[REPLICAS_ANNOTATION];
          if (kept === undefined || !item.metadata?.name) continue;
          await this.kubectl(['scale', kind, item.metadata.name, '-n', namespace, `--replicas=${kept}`]);
          await this.kubectl(['annotate', kind, item.metadata.name, '-n', namespace, `${REPLICAS_ANNOTATION}-`]);
        }
      }
      await this.kubectl(['delete', 'pod', VOLUME_HELPER, '-n', namespace, '--ignore-not-found']);
    }
    await this.selfUpgrade(true).catch(() => undefined);
    await fs.rm(path.join(this.deps.dataDir, MOVING_FILE), { force: true });
    this.frozen = false;
  }

  private selfUpgrade(on: boolean): Promise<string> {
    return this.kubectl(['patch', 'cronjob', SELF_UPGRADE.name, '-n', SELF_UPGRADE.namespace, '--type=merge', '-p', JSON.stringify({ spec: { suspend: !on } })]);
  }

  private kubectl(args: string[]): Promise<string> {
    const { out, done } = this.command(['kubectl', ...args]);
    let text = '';
    out.on('data', (chunk) => { text += chunk; });
    return done.then(() => text);
  }

  private async namespaces(): Promise<string[]> {
    const listed = JSON.parse(await this.kubectl(['get', 'namespaces', '-o', 'json'])) as { items?: KubeObject[] };
    return (listed.items ?? []).map((item) => item.metadata?.name ?? '').filter(isMovedNamespace).sort();
  }

  async apps(pullHost: string): Promise<AppsManifest> {
    const namespaces: MovedNamespace[] = [];
    for (const namespace of await this.namespaces()) {
      for (const kind of SCALED_KINDS) {
        const listed = JSON.parse(await this.kubectl(['get', kind, '-n', namespace, '-o', 'json'])) as { items?: KubeObject[] };
        for (const item of listed.items ?? []) {
          const name = item.metadata?.name;
          if (!name) continue;
          if (item.metadata?.annotations?.[REPLICAS_ANNOTATION] === undefined) {
            await this.kubectl(['annotate', kind, name, '-n', namespace, `${REPLICAS_ANNOTATION}=${Number(item.spec?.replicas ?? 1)}`]);
          }
          await this.kubectl(['scale', kind, name, '-n', namespace, '--replicas=0']);
        }
      }
      const objects: KubeObject[] = [];
      const listed = JSON.parse(await this.kubectl(['get', COPIED_KINDS.join(','), '-n', namespace, '-o', 'json', '--ignore-not-found'])) as { items?: KubeObject[] };
      objects.push(...(listed.items ?? []).filter(copied));
      const ns = JSON.parse(await this.kubectl(['get', 'namespace', namespace, '-o', 'json'])) as KubeObject;
      namespaces.push({ namespace, labels: ns.metadata?.labels ?? {}, objects, volumes: volumesOf(objects) });
    }
    for (const entry of namespaces) {
      for (;;) {
        const pods = JSON.parse(await this.kubectl(['get', 'pods', '-n', entry.namespace, '-o', 'json'])) as { items?: Array<{ metadata?: { ownerReferences?: Array<{ kind?: string }> } }> };
        const left = (pods.items ?? []).filter((pod) => pod.metadata?.ownerReferences?.some((owner) => owner.kind === 'ReplicaSet' || owner.kind === 'StatefulSet'));
        if (left.length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    return { pullHost, namespaces };
  }

  volume(namespace: string, claim: string): { out: Readable; done: Promise<void>; type: string } {
    const out = new PassThrough();
    const done = (async () => {
      await this.kubectl(['delete', 'pod', VOLUME_HELPER, '-n', namespace, '--ignore-not-found', '--wait=true']);
      const overrides = {
        spec: {
          containers: [{ name: VOLUME_HELPER, image: HELPER_IMAGE, command: ['sleep', 'infinity'], volumeMounts: [{ name: 'volume', mountPath: '/volume', readOnly: true }] }],
          volumes: [{ name: 'volume', persistentVolumeClaim: { claimName: claim, readOnly: true } }],
        },
      };
      await this.kubectl(['run', VOLUME_HELPER, '-n', namespace, `--image=${HELPER_IMAGE}`, '--restart=Never', `--overrides=${JSON.stringify(overrides)}`]);
      await this.kubectl(['wait', `pod/${VOLUME_HELPER}`, '-n', namespace, '--for=condition=Ready', '--timeout=720h']);
      const tar = this.command(['kubectl', 'exec', '-n', namespace, VOLUME_HELPER, '--', 'tar', 'czf', '-', '-C', '/volume', '.']);
      tar.out.pipe(out);
      try {
        await tar.done;
      } finally {
        await this.kubectl(['delete', 'pod', VOLUME_HELPER, '-n', namespace, '--ignore-not-found', '--wait=false']).catch(() => '');
      }
    })();
    done.catch((err: Error) => out.destroy(err));
    return { out, done, type: 'application/gzip' };
  }

  private command(args: string[]): { out: Readable; done: Promise<void> } {
    const child: ChildProcess = (this.deps.spawn ?? spawnProcess)(args[0]!, args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let said = '';
    child.stderr?.on('data', (chunk) => { said = `${said}${chunk}`.slice(-2000); });
    const done = new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${args[0]} ended with ${code}: ${said.trim()}`))));
    });
    return { out: child.stdout!, done };
  }

  private mongo(): { out: Readable; done: Promise<void> } {
    const out = new PassThrough();
    const gzip = zlib.createGzip();
    gzip.pipe(out);
    const done = (async () => {
      const client = new MongoClient(this.deps.mongo.uri);
      await client.connect();
      try {
        for await (const line of exportLines(client.db(this.deps.mongo.dbName))) {
          if (!gzip.write(line)) await new Promise((resolve) => gzip.once('drain', resolve));
        }
      } finally {
        await client.close();
        gzip.end();
      }
    })();
    done.catch((err: Error) => out.destroy(err));
    return { out, done };
  }

  open(part: MovePart): { out: Readable; done: Promise<void>; type: string } {
    switch (part) {
      case 'keys': {
        const text = keysEnv(this.deps.env);
        if (typeof text !== 'string') throw new Error(text.error);
        const out = new PassThrough();
        out.end(text);
        return { out, done: Promise.resolve(), type: 'text/plain' };
      }
      case 'data': {
        const entries = readdirSync(this.deps.dataDir).filter((name) => name !== MOVING_FILE && name !== 'logs').sort();
        return { ...this.command(['tar', 'czf', '-', '-C', this.deps.dataDir, '--', ...entries]), type: 'application/gzip' };
      }
      case 'mongo':
        return { ...this.mongo(), type: 'application/gzip' };
      case 'gitea-db':
      case 'infisical-db': {
        const place = MOVED_POSTGRES[part];
        return { ...this.command(['kubectl', 'exec', '-n', place.namespace, place.pod, '--', 'sh', '-c', PG_DUMP]), type: 'application/octet-stream' };
      }
      case 'gitea-data':
        return { ...this.command(['kubectl', 'exec', '-n', GITEA_DATA.namespace, `deploy/${GITEA_DATA.deployment}`, '-c', GITEA_DATA.container, '--', 'tar', 'czf', '-', '-C', GITEA_DATA.path, '.']), type: 'application/gzip' };
      case 'apps': {
        const out = new PassThrough();
        const done = this.apps(this.deps.env.REGISTRY_PULL_HOST?.trim() ?? '').then((manifest) => { out.end(JSON.stringify(manifest)); });
        done.catch((err: Error) => out.destroy(err));
        return { out, done, type: 'application/json' };
      }
    }
  }
}
