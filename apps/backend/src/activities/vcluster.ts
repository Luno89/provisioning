import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { ClusterAccess, Target } from '../infrastructure/index.js';
import { VCLUSTER_CHART_VERSION } from '../instances/index.js';
import { waitingOn } from './failure-reasons.js';

export interface VclusterPlace {
  name: string;
  namespace: string;
  values: Record<string, unknown>;
}

export const vclusterSecret = (name: string): string => `vc-${name}`;

export async function installVcluster(
  access: Pick<ClusterAccess, 'kubectl' | 'helm'>,
  node: Target,
  place: VclusterPlace,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const { name, namespace } = place;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcluster-'));
  try {
    const values = path.join(dir, 'vcluster.json');
    await fs.writeFile(values, JSON.stringify(place.values));
    await access.helm(node, ['upgrade', '--install', name, 'vcluster', '--repo', 'https://charts.loft.sh', '--version', VCLUSTER_CHART_VERSION,
      '-n', namespace, '--wait', '--timeout', '720h', '-f', values]);
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
