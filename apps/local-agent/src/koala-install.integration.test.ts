import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { machineChartCluster } from './koala-install.js';
import { K3S_BINARY, K3S_KUBECONFIG, hostCluster } from './machine-cluster.js';

const HELM = '/usr/local/lib/koala/helm';
const made: string[] = [];
afterEach(async () => { for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true }); });

const program = (name: string) => `#!/bin/sh
config=""
while [ $# -gt 0 ]; do
  if [ "$1" = --kubeconfig ]; then config="$2"; shift 2; else printf '%s ' "$1"; shift; fi
done
[ -r "$config" ] || { echo "${name}: no kubeconfig at $config" >&2; exit 1; }
printf 'against %s\\n' "$(cat "$config")"
`;

const throwawayMachine = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'koala-install-machine-'));
  made.push(root);
  const on = (file: string) => path.join(root, file);
  for (const [file, name] of [[K3S_BINARY, 'k3s'], [HELM, 'helm']] as const) {
    await mkdir(path.dirname(on(file)), { recursive: true });
    await writeFile(on(file), program(name));
    await chmod(on(file), 0o755);
  }
  const host = hostCluster(async () => '100.64.0.7', { wantedAt: on('wanted'), koalaHere: on('koala-here'), machineRoot: root });
  return { on, cluster: machineChartCluster(host, HELM) };
};

describe('Koala\'s chart reaches this machine\'s own k3s, as the install runs it on the machine', () => {
  it('runs kubectl through k3s and helm against the kubeconfig k3s wrote on this machine', async () => {
    const machine = await throwawayMachine();
    await mkdir(path.dirname(machine.on(K3S_KUBECONFIG)), { recursive: true });
    await writeFile(machine.on(K3S_KUBECONFIG), 'this machine\'s k3s');
    expect(await machine.cluster.kubectl(['get', 'deployments', '-n', 'nowrinkles'])).toBe('kubectl get deployments -n nowrinkles against this machine\'s k3s\n');
    expect(await machine.cluster.helm(['status', 'instance', '-n', 'nowrinkles'])).toBe('status instance -n nowrinkles against this machine\'s k3s\n');
  });

  it('fails with what k3s said when this machine has no kubeconfig of k3s\'s yet', async () => {
    const machine = await throwawayMachine();
    await expect(machine.cluster.kubectl(['get', 'pods'])).rejects.toThrow(`k3s: no kubeconfig at ${machine.on(K3S_KUBECONFIG)}`);
  });
});
