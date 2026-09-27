import { spawn } from 'node:child_process';
import type { EgressGrantRecord } from '@koala/harness-types';
import { renderGrants } from '../lib/egress-proxy.js';

export const PROXY_NAMESPACE = 'koala-egress';

export interface ProxyKube {
  applyManifest(manifest: string, kubeconfig?: string): Promise<unknown>;
  runKubectl(args: string[], kubeconfig?: string): Promise<unknown>;
}

export function sha512Crypt(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('openssl', ['passwd', '-6', '-salt', salt, '-stdin'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`openssl could not hash: ${err.trim()}`))));
    child.stdin.end(password);
  });
}

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

export class EgressProxyService {
  constructor(private readonly deps: { kube: ProxyKube; secret: string; kubeconfig: string }) {}

  async files(grants: readonly EgressGrantRecord[]): Promise<{ passwd: string; acls: string }> {
    const active = grants.filter((grant) => !grant.revokedAt);
    const { users, acls } = renderGrants(this.deps.secret, active);
    const lines = await Promise.all(users.map(async ({ user, password }) => `${user}:${await sha512Crypt(password, user.slice(1, 17))}`));
    return { passwd: lines.length ? `${lines.join('\n')}\n` : '', acls };
  }

  async sync(grants: readonly EgressGrantRecord[]): Promise<void> {
    const { passwd, acls } = await this.files(grants);
    await this.deps.kube.applyManifest(JSON.stringify({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'egress-grants', namespace: PROXY_NAMESPACE },
      data: { passwd, 'acls.conf': acls },
    }), this.deps.kubeconfig);
    await this.deps.kube.runKubectl([
      'exec', '-n', PROXY_NAMESPACE, 'deploy/egress-proxy', '-c', 'squid', '--', 'sh', '-c',
      `echo ${b64(passwd)} | base64 -d > /etc/squid/grants/passwd && echo ${b64(acls)} | base64 -d > /etc/squid/grants/acls.conf && squid -k reconfigure -f /etc/squid/squid.conf`,
    ], this.deps.kubeconfig);
  }
}
