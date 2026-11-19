import type { EgressGrantRecord } from '@koala/harness-types';
import { renderGrants } from '../lib/egress-proxy.js';
import { nodeProcesses, type Processes } from '../../platform/index.js';
import type { ClusterAccess } from './ClusterAccess.js';

export const PROXY_NAMESPACE = 'koala-egress';

export type ProxyKube = Pick<ClusterAccess, 'own' | 'apply' | 'kubectl'>;

export async function sha512Crypt(password: string, salt: string, processes: Processes = nodeProcesses): Promise<string> {
  const hashed = await processes.run({ command: 'openssl', args: ['passwd', '-6', '-salt', salt, '-stdin'], input: password });
  if (hashed.code !== 0) throw new Error(`openssl could not hash: ${hashed.stderr.trim()}`);
  return hashed.stdout.trim();
}

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

export class EgressProxyService {
  constructor(private readonly deps: { kube: ProxyKube; secret: string; processes?: Processes | undefined }) {}

  async files(grants: readonly EgressGrantRecord[]): Promise<{ passwd: string; acls: string }> {
    const active = grants.filter((grant) => !grant.revokedAt);
    const { users, acls } = renderGrants(this.deps.secret, active);
    const lines = await Promise.all(users.map(async ({ user, password }) => `${user}:${await sha512Crypt(password, user.slice(1, 17), this.deps.processes)}`));
    return { passwd: lines.length ? `${lines.join('\n')}\n` : '', acls };
  }

  async sync(grants: readonly EgressGrantRecord[]): Promise<void> {
    const { passwd, acls } = await this.files(grants);
    const koala = this.deps.kube.own();
    await this.deps.kube.apply(koala, JSON.stringify({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'egress-grants', namespace: PROXY_NAMESPACE },
      data: { passwd, 'acls.conf': acls },
    }));
    await this.deps.kube.kubectl(koala, [
      'exec', '-n', PROXY_NAMESPACE, 'deploy/egress-proxy', '-c', 'squid', '--', 'sh', '-c',
      `echo ${b64(passwd)} | base64 -d > /etc/squid/grants/passwd && echo ${b64(acls)} | base64 -d > /etc/squid/grants/acls.conf && squid -k reconfigure -f /etc/squid/squid.conf`,
    ]);
  }
}
