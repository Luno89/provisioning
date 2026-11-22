import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { K3S_BINARY, K3S_KUBECONFIG, hostCluster, machineChartCluster, wantedFile } from './machine-cluster.js';

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'machine-cluster-host-'));
  made.push(dir);
  return dir;
};

describe('the machine as its cluster sees it', () => {
  it('keeps that its cluster should run in a file under the person\'s data folder, which a restarted agent reads again', async () => {
    const data = folder();
    const wanted = wantedFile({ XDG_DATA_HOME: data });
    expect(wanted).toBe(join(data, 'koala', 'cluster-wanted'));
    const before = hostCluster(async () => undefined, { wantedAt: wanted });
    expect(await before.isWanted()).toBe(false);
    await before.wanted(true);
    expect(existsSync(wanted)).toBe(true);
    expect(await hostCluster(async () => undefined, { wantedAt: wanted }).isWanted()).toBe(true);
    await before.wanted(false);
    await before.wanted(false);
    expect(await hostCluster(async () => undefined, { wantedAt: wanted }).isWanted()).toBe(false);
  });

  it('runs real programs, reads real files, and asks the mesh for its address', async () => {
    const dir = folder();
    const config = join(dir, 'k3s.yaml');
    writeFileSync(config, 'server: https://127.0.0.1:6443\n');
    const host = hostCluster(async () => '100.64.0.7', { wantedAt: join(dir, 'wanted') });
    expect(await host.run(process.execPath, ['-e', 'process.stdout.write("active")'])).toBe('active');
    await expect(host.run(process.execPath, ['-e', 'process.exit(3)'])).rejects.toThrow();
    expect(await host.exists(config)).toBe(true);
    expect(await host.exists(join(dir, 'nothing'))).toBe(false);
    expect(await host.read(config)).toBe('server: https://127.0.0.1:6443\n');
    expect(await host.meshIp()).toBe('100.64.0.7');
    const before = host.now();
    await host.pause(5);
    expect(host.now()).toBeGreaterThanOrEqual(before + 5);
  });
});

const HELM = '/usr/local/lib/koala/helm';
const program = (name: string) => `#!/bin/sh
config=""
while [ $# -gt 0 ]; do
  if [ "$1" = --kubeconfig ]; then config="$2"; shift 2; else printf '%s ' "$1"; shift; fi
done
[ -r "$config" ] || { echo "${name}: no kubeconfig at $config" >&2; exit 1; }
printf 'against %s\\n' "$(cat "$config")"
`;

const throwawayMachine = async () => {
  const root = folder();
  const on = (file: string) => join(root, file);
  for (const [file, name] of [[K3S_BINARY, 'k3s'], [HELM, 'helm']] as const) {
    mkdirSync(dirname(on(file)), { recursive: true });
    writeFileSync(on(file), program(name), { mode: 0o755 });
  }
  const host = hostCluster(async () => '100.64.0.7', { wantedAt: on('wanted'), koalaHere: on('koala-here'), machineRoot: root });
  return { on, cluster: machineChartCluster(host, HELM) };
};

describe('Koala\'s chart reaches this machine\'s own k3s, as the install runs it on the machine', () => {
  it('runs kubectl through k3s and helm against the kubeconfig k3s wrote on this machine', async () => {
    const machine = await throwawayMachine();
    mkdirSync(dirname(machine.on(K3S_KUBECONFIG)), { recursive: true });
    writeFileSync(machine.on(K3S_KUBECONFIG), 'this machine\'s k3s');
    expect(await machine.cluster.kubectl(['get', 'deployments', '-n', 'nowrinkles'])).toBe('kubectl get deployments -n nowrinkles against this machine\'s k3s\n');
    expect(await machine.cluster.helm(['status', 'instance', '-n', 'nowrinkles'])).toBe('status instance -n nowrinkles against this machine\'s k3s\n');
  });

  it('watches through k3s\'s kubectl, its API path left as the path it is, hearing what it prints as it goes', async () => {
    const machine = await throwawayMachine();
    mkdirSync(dirname(machine.on(K3S_KUBECONFIG)), { recursive: true });
    writeFileSync(machine.on(K3S_KUBECONFIG), 'this machine\'s k3s');
    let heard = '';
    const watch = await machine.cluster.watch('/api/v1/namespaces/nowrinkles/pods?watch=1', (chunk) => { heard += chunk; });
    expect(await watch.ended).toEqual({ code: 0, stderr: '' });
    expect(heard).toBe('kubectl get --raw=/api/v1/namespaces/nowrinkles/pods?watch=1 against this machine\'s k3s\n');
  });

  it('fails with what k3s said when this machine has no kubeconfig of k3s\'s yet', async () => {
    const machine = await throwawayMachine();
    await expect(machine.cluster.kubectl(['get', 'pods'])).rejects.toThrow(`k3s: no kubeconfig at ${machine.on(K3S_KUBECONFIG)}`);
  });
});
