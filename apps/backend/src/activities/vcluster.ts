import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { ClusterAccess, Target } from '../infrastructure/index.js';
import { waitingOn } from './failure-reasons.js';

export const VCLUSTER_CHART_VERSION = '0.37.2';
export const VCLUSTER_CHART_SHA256 = '0e3e1df3802a1199653930cfadcf52ba309ea7d5282a1a8541452bea8a9cf707';

export interface VclusterPlace {
  name: string;
  namespace: string;
  values: Record<string, unknown>;
}

export type VclusterAccess = Pick<ClusterAccess, 'kubectl' | 'helm'>;

export const vclusterSecret = (name: string): string => `vc-${name}`;

export const VCLUSTER_CHART_FILE = `vcluster-${VCLUSTER_CHART_VERSION}.tgz`;

const present = (file: string): Promise<boolean> => fs.access(file).then(() => true, (err: NodeJS.ErrnoException) => {
  if (err.code === 'ENOENT') return false;
  throw err;
});

const fetching = new Map<string, Promise<string>>();

export function vclusterChart(access: VclusterAccess, node: Target, charts: string): Promise<string> {
  const cached = path.join(charts, VCLUSTER_CHART_FILE);
  const running = fetching.get(cached);
  if (running) return running;
  const fetched = (async () => {
    if (await present(cached)) return cached;
    await fs.mkdir(charts, { recursive: true });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcluster-chart-'));
    try {
      await access.helm(node, ['pull', 'vcluster', '--repo', 'https://charts.loft.sh', '--version', VCLUSTER_CHART_VERSION, '--destination', dir]);
      const pulled = path.join(dir, VCLUSTER_CHART_FILE);
      const digest = createHash('sha256').update(await fs.readFile(pulled)).digest('hex');
      if (digest !== VCLUSTER_CHART_SHA256) throw new Error(`the vcluster chart ${VCLUSTER_CHART_VERSION} its repository gave has the digest ${digest}, not the pinned ${VCLUSTER_CHART_SHA256}, so it was not installed`);
      const landing = path.join(charts, `.${VCLUSTER_CHART_FILE}.${randomUUID()}`);
      await fs.copyFile(pulled, landing);
      await fs.rename(landing, cached);
      return cached;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  })().finally(() => fetching.delete(cached));
  fetching.set(cached, fetched);
  return fetched;
}

export async function installVcluster(access: VclusterAccess, node: Target, charts: string, place: VclusterPlace, sleep: (ms: number) => Promise<void>): Promise<void> {
  const { name, namespace } = place;
  const chart = await vclusterChart(access, node, charts);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcluster-'));
  try {
    const values = path.join(dir, 'vcluster.json');
    await fs.writeFile(values, JSON.stringify(place.values));
    await access.helm(node, ['upgrade', '--install', name, chart, '-n', namespace, '--wait', '--timeout', '720h', '-f', values]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  const waiting = waitingOn(`the vcluster ${name}'s sign-in`);
  for (;;) {
    const secret = await access.kubectl(node, ['get', 'secret', vclusterSecret(name), '-n', namespace, '-o', 'name']).catch((err: unknown) => { waiting(err); return ''; });
    if (secret.trim()) break;
    await sleep(2000);
  }
}
