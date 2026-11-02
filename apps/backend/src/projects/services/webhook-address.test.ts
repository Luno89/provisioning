import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { InfrastructureService } from '../../infrastructure/index.js';
import { webhookAddress } from './webhook-address.js';

function setUp() {
  const infra = mock<Pick<InfrastructureService, 'runKubectl'>>();
  const nodeIp = matches<string[]>((args) => args.join(' ').startsWith('get nodes -o jsonpath='));
  return { infra, nodeIp };
}

describe('the address Gitea sends a project\'s pushes to', () => {
  it('is the cluster node\'s address on the backend port, ending in the project', async () => {
    const { infra, nodeIp } = setUp();
    infra.runKubectl.calledWith(nodeIp, '/tmp/kubeconfig').mockResolvedValue('10.0.0.5\n');
    const addressOf = webhookAddress(infra, '/tmp/kubeconfig', 3001);
    expect(await addressOf('p1')).toBe('http://10.0.0.5:3001/webhooks/gitea/p1');
  });

  it('asks the cluster once however many projects ask', async () => {
    const { infra, nodeIp } = setUp();
    infra.runKubectl.calledWith(nodeIp, 'kube').mockResolvedValue('10.0.0.5');
    const addressOf = webhookAddress(infra, 'kube', '3001');
    expect(await Promise.all([addressOf('a'), addressOf('b')])).toEqual(['http://10.0.0.5:3001/webhooks/gitea/a', 'http://10.0.0.5:3001/webhooks/gitea/b']);
    await addressOf('c');
    expect(infra.runKubectl).toHaveBeenCalledTimes(1);
  });

  it('asks again after a failed look, rather than remembering the failure', async () => {
    const { infra, nodeIp } = setUp();
    infra.runKubectl.calledWith(nodeIp, 'kube').mockRejectedValueOnce(new Error('cluster is down')).mockResolvedValue('10.0.0.5');
    const addressOf = webhookAddress(infra, 'kube', 3001);
    await expect(addressOf('p1')).rejects.toThrow('cluster is down');
    expect(await addressOf('p1')).toBe('http://10.0.0.5:3001/webhooks/gitea/p1');
  });

  it('is refused when the cluster gives no node address', async () => {
    const { infra, nodeIp } = setUp();
    infra.runKubectl.calledWith(nodeIp, 'kube').mockResolvedValue('  \n');
    await expect(webhookAddress(infra, 'kube', 3001)('p1')).rejects.toThrow('the cluster gave no node address for the build webhook');
  });
});
