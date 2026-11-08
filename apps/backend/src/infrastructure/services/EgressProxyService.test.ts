import { describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { EgressGrantRecord } from '@koala/harness-types';
import { proxyPassword, proxyUser } from '../lib/egress-proxy.js';
import type { StartProcess } from '../lib/shell.js';
import { fakeChild } from '../testing/fake-child.js';
import { EgressProxyService, PROXY_NAMESPACE, sha512Crypt, type ProxyKube } from './EgressProxyService.js';

function openssl(outcome: { stdout?: string; stderr?: string; code?: number; error?: Error }): { start: StartProcess; asked: { command: string; args: string[]; input: string }[] } {
  const asked: { command: string; args: string[]; input: string }[] = [];
  const start: StartProcess = (command, args) => {
    const { child, events, stdin, stdout, stderr } = fakeChild();
    let input = '';
    stdin.on('data', (chunk: Buffer) => { input += chunk.toString(); });
    stdin.on('finish', () => {
      asked.push({ command, args, input });
      setImmediate(() => {
        if (outcome.error) { events.emit('error', outcome.error); return; }
        if (outcome.stdout) stdout.emit('data', Buffer.from(outcome.stdout));
        if (outcome.stderr) stderr.emit('data', Buffer.from(outcome.stderr));
        events.emit('close', outcome.code ?? 0);
      });
    });
    return child;
  };
  return { start, asked };
}

const grant = (over: Partial<EgressGrantRecord> = {}): EgressGrantRecord => ({ id: 'g1', ownerId: 'o1', agentSlug: 'executor', host: 'api.example.com', reason: 'r', approvedBy: 'o1', approvedAt: 'x', ...over });

describe('sha512Crypt', () => {
  it('hashes a password with openssl, reading it from stdin and salting it as asked', async () => {
    const { start, asked } = openssl({ stdout: '$6$salt$hashed\n' });
    expect(await sha512Crypt('hunter2', 'salt', start)).toBe('$6$salt$hashed');
    expect(asked).toEqual([{ command: 'openssl', args: ['passwd', '-6', '-salt', 'salt', '-stdin'], input: 'hunter2' }]);
  });

  it('fails with what openssl said when it cannot hash', async () => {
    const { start } = openssl({ stderr: 'bad salt\n', code: 1 });
    await expect(sha512Crypt('x', 'y', start)).rejects.toThrow('openssl could not hash: bad salt');
  });

  it('fails when openssl cannot be started', async () => {
    const { start } = openssl({ error: new Error('spawn openssl ENOENT') });
    await expect(sha512Crypt('x', 'y', start)).rejects.toThrow('spawn openssl ENOENT');
  });
});

describe('EgressProxyService', () => {
  const service = (start: StartProcess, kube: MockProxy<ProxyKube> = mock<ProxyKube>()) => ({ kube, egress: new EgressProxyService({ kube, secret: 'egress-secret', start }) });

  it('writes a password line for each agent holding a grant, hashed, and the rules that let it through', async () => {
    const { start, asked } = openssl({ stdout: '$6$hashed\n' });
    const { egress } = service(start);
    const files = await egress.files([grant(), grant({ id: 'g2', host: 'other.example.com' }), grant({ id: 'g3', agentSlug: 'research', host: 'docs.example.com' })]);
    const executor = proxyUser('o1', 'executor');
    const research = proxyUser('o1', 'research');
    expect(files.passwd.split('\n').filter(Boolean).sort()).toEqual([`${executor}:$6$hashed`, `${research}:$6$hashed`].sort());
    expect(asked.map((run) => run.input).sort()).toEqual([proxyPassword('egress-secret', executor), proxyPassword('egress-secret', research)].sort());
    expect(files.acls).toContain(`acl hosts_${executor} dstdomain api.example.com other.example.com`);
    expect(files.acls).toContain(`http_access allow CONNECT user_${research} hosts_${research} ports_${research}`);
  });

  it('leaves a revoked grant out, and writes no passwords when none is left', async () => {
    const { start, asked } = openssl({ stdout: 'x' });
    const files = await service(start).egress.files([grant({ revokedAt: 'y' })]);
    expect(files).toEqual({ passwd: '', acls: '' });
    expect(asked).toEqual([]);
  });

  it('asks for Koala\'s own cluster when it syncs, and changes nothing where this process has none', async () => {
    const { start } = openssl({ stdout: '$6$hashed\n' });
    const { egress, kube } = service(start);
    kube.own.mockImplementation(() => { throw new Error('this process runs in no cluster of its own'); });
    await expect(egress.sync([grant()])).rejects.toThrow('this process runs in no cluster of its own');
    expect(kube.apply).not.toHaveBeenCalled();
    expect(kube.kubectl).not.toHaveBeenCalled();
  });

  it('puts the grants in a config map and tells the running proxy to reload them', async () => {
    const { start } = openssl({ stdout: '$6$hashed\n' });
    const { egress, kube } = service(start);
    const koala = { clusterId: 'machine-desk', kind: 'koala' } as const;
    kube.own.mockReturnValue(koala);
    await egress.sync([grant()]);
    expect(kube.apply).toHaveBeenCalledTimes(1);
    const [target, manifest] = kube.apply.mock.calls[0]!;
    expect(target).toBe(koala);
    const applied = JSON.parse(String(manifest)) as { kind: string; metadata: { name: string; namespace: string }; data: { passwd: string; 'acls.conf': string } };
    expect(applied).toMatchObject({ kind: 'ConfigMap', metadata: { name: 'egress-grants', namespace: PROXY_NAMESPACE } });
    expect(applied.data.passwd).toContain('$6$hashed');
    const [on, args] = kube.kubectl.mock.calls[0]!;
    expect(on).toBe(koala);
    expect(args.slice(0, 6)).toEqual(['exec', '-n', PROXY_NAMESPACE, 'deploy/egress-proxy', '-c', 'squid']);
    expect(String(args.at(-1))).toContain(Buffer.from(applied.data['acls.conf']).toString('base64'));
    expect(String(args.at(-1))).toContain('squid -k reconfigure');
  });
});
