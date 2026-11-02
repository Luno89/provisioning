import { describe, expect, it } from 'vitest';
import { matches, mockFn } from 'vitest-mock-extended';
import type { Shell, ShellOptions } from '../lib/shell.js';
import { InfrastructureService } from './InfrastructureService.js';

const output = (stdout: string) => ({ stdout, stderr: '' });
const commandEnding = (end: string) => matches<string>((command) => command.endsWith(end));
const keptKubeconfig = (kubeconfig: string) => matches<ShellOptions | undefined>((options) => options?.env?.KUBECONFIG === kubeconfig);

describe('InfrastructureService.runKubectl', () => {
  it('runs the bundled kubectl on the host with each argument quoted, against the kubeconfig named', async () => {
    const shell = mockFn<Shell>();
    shell.calledWith(commandEnding("/bin/kubectl' 'get' 'pods' '-n' 'it'\\''s'"), keptKubeconfig('/home/me/kube.yaml')).mockResolvedValue(output('pods'));
    expect(await new InfrastructureService(shell).runKubectl(['get', 'pods', '-n', "it's"], '/home/me/kube.yaml')).toBe('pods');
  });

  it('falls back to the default kubeconfig when none is named', async () => {
    const shell = mockFn<Shell>();
    shell.calledWith(commandEnding("/bin/kubectl' 'get' 'ns'"), keptKubeconfig(`${process.env.HOME}/.kube/config`)).mockResolvedValue(output('ns'));
    expect(await new InfrastructureService(shell).runKubectl(['get', 'ns'])).toBe('ns');
  });

  it('runs kubectl inside the k3d server container when the kubeconfig belongs to a local cluster whose container exists, leaving out --context', async () => {
    const shell = mockFn<Shell>();
    shell.calledWith("docker inspect 'k3d-demo-server-0'").mockResolvedValue(output('{}'));
    shell.calledWith("docker exec k3d-demo-server-0 kubectl 'get' 'pods'").mockResolvedValue(output('inside'));
    expect(await new InfrastructureService(shell).runKubectl(['--context', 'k3d-demo', 'get', 'pods'], '/tmp/kubeconfig-demo')).toBe('inside');
  });

  it('runs kubectl on the host when the cluster\'s container is not there', async () => {
    const shell = mockFn<Shell>();
    shell.calledWith("docker inspect 'k3d-gone-server-0'").mockRejectedValue(new Error('No such object'));
    shell.calledWith(commandEnding("/bin/kubectl' 'get' 'pods'"), keptKubeconfig('/tmp/kubeconfig-gone')).mockResolvedValue(output('host'));
    expect(await new InfrastructureService(shell).runKubectl(['get', 'pods'], '/tmp/kubeconfig-gone')).toBe('host');
  });

  it('fails with kubectl\'s own error', async () => {
    const shell = mockFn<Shell>();
    shell.mockRejectedValue(new Error('the server could not find the requested resource'));
    await expect(new InfrastructureService(shell).runKubectl(['get', 'nothing'])).rejects.toThrow('the server could not find the requested resource');
  });
});

describe('InfrastructureService.getManagementClusterKubeconfig', () => {
  it('renames the management cluster\'s context to the physical cluster\'s', async () => {
    const shell = mockFn<Shell>();
    shell.calledWith(matches<string>((command) => command.includes('config view --minify --raw --context=k3d-provisioning-lunorica'))).mockResolvedValue(output('current-context: k3d-provisioning-lunorica\n'));
    expect(await new InfrastructureService(shell).getManagementClusterKubeconfig('lab')).toBe('current-context: k3d-lab\n');
  });

  it('says the management cluster is not running when its context is not in the kubeconfig', async () => {
    const shell = mockFn<Shell>();
    shell.mockResolvedValue(output('current-context: other\n'));
    await expect(new InfrastructureService(shell).getManagementClusterKubeconfig('lab')).rejects.toThrow(/Management cluster context "k3d-provisioning-lunorica" not found/);
  });
});

describe('InfrastructureService.listLocalClusters', () => {
  it('lists the names k3d prints, one per line', async () => {
    const shell = mockFn<Shell>();
    shell.calledWith(commandEnding('/bin/k3d cluster list --no-headers')).mockResolvedValue(output('alpha   1/1   0/0   true\nbeta    1/1   0/0   true\n\n'));
    expect(await new InfrastructureService(shell).listLocalClusters()).toEqual(['alpha', 'beta']);
  });

  it('lists none when k3d cannot be run', async () => {
    const shell = mockFn<Shell>();
    shell.mockRejectedValue(new Error('k3d: not found'));
    expect(await new InfrastructureService(shell).listLocalClusters()).toEqual([]);
  });
});
