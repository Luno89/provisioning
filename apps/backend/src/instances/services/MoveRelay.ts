import fs from 'fs/promises';
import https from 'https';
import type { IncomingMessage } from 'http';
import { kubeAccessFrom, serviceProxyPath, type KubeAccess } from '../lib/kubeconfig-access.js';
import { INSTANCE_RELEASE, poolNamespace, syncedService } from '../lib/pool.js';
import { MOVE_TOKEN_HEADER } from '../lib/identity-token.js';

export interface MoveRelayDeps {
  kubeconfig: () => Promise<string>;
  sign: (instanceId: string, part: string) => string;
  request?: typeof https.request;
}

export function kubeconfigFile(path: string): () => Promise<string> {
  return () => fs.readFile(path, 'utf8');
}

export class MoveRelay {
  constructor(private readonly deps: MoveRelayDeps) {}

  private async access(): Promise<KubeAccess> {
    return kubeAccessFrom(await this.deps.kubeconfig());
  }

  async open(source: { name: string; instanceId: string }, part: string, method: 'GET' | 'POST' = 'GET'): Promise<IncomingMessage> {
    const access = await this.access();
    const token = this.deps.sign(source.instanceId, part);
    const service = syncedService(INSTANCE_RELEASE.name, INSTANCE_RELEASE.namespace, source.name);
    const path = serviceProxyPath(poolNamespace(source.name), service, 80, `/api/move/${part === 'thaw' ? 'thaw' : `parts/${encodeURIComponent(part)}`}`);
    const url = new URL(`${access.server}${path}`);
    const request = this.deps.request ?? https.request;
    return new Promise((resolve, reject) => {
      const outgoing = request({
        method,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        ...(access.ca ? { ca: access.ca } : {}),
        ...(access.cert ? { cert: access.cert } : {}),
        ...(access.key ? { key: access.key } : {}),
        ...(access.insecure ? { rejectUnauthorized: false } : {}),
        headers: { [MOVE_TOKEN_HEADER]: token, ...(access.token ? { authorization: `Bearer ${access.token}` } : {}) },
      }, resolve);
      outgoing.on('error', reject);
      outgoing.end();
    });
  }
}
