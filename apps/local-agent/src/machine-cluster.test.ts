import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { MACHINE_CLUSTER_ABSENT, MACHINE_OFF_MESH } from '@koala/engine-core';
import { K3S_BINARY, K3S_KILLALL, K3S_KUBECONFIG, K3S_MARKER, K3S_UNINSTALL, clusterOnConnect, clusterState, kubeconfigOnMesh, readySince, runMachineCluster, startIfWanted, uninstallMachineCluster, type ClusterHost } from './machine-cluster.js';

const START = Date.parse('2026-11-05T10:00:00Z');
const KUBECONFIG = 'apiVersion: v1\nclusters:\n- cluster:\n    server: https://127.0.0.1:6443\n';
const at = (ms: number) => new Date(ms).toISOString();

function host(opts: { installed?: boolean; active?: string; meshIp?: string | undefined; readyAt?: number[]; failsAfter?: number; wanted?: boolean; koala?: boolean } = {}) {
  const machine = mock<ClusterHost>();
  const calls: string[] = [];
  const readyAt = [...(opts.readyAt ?? [START + 5000])];
  let state = opts.active ?? 'inactive';
  let asked = 0;
  machine.exists.mockImplementation(async (path) => (opts.installed ?? true) && [K3S_MARKER, K3S_UNINSTALL].includes(path));
  machine.read.mockImplementation(async (path) => { if (path !== K3S_KUBECONFIG) throw new Error(path); return KUBECONFIG; });
  machine.meshIp.mockResolvedValue('meshIp' in opts ? opts.meshIp : '100.64.0.7');
  machine.now.mockReturnValue(START);
  machine.pause.mockResolvedValue(undefined);
  let wanted = opts.wanted ?? false;
  machine.wanted.mockImplementation(async (running) => { wanted = running; calls.push(`wanted ${running}`); });
  machine.isWanted.mockImplementation(async () => wanted);
  machine.holdsKoala.mockResolvedValue(opts.koala ?? false);
  machine.run.mockImplementation(async (file, args) => {
    calls.push([file, ...args].join(' '));
    if (file === 'systemctl' && args[0] === 'show') return `${state}\n`;
    if (file === 'systemctl' && args[0] === 'status') return 'k3s.service - failed: no space left';
    if (file === 'sudo' && args.includes('start')) { state = 'active'; return ''; }
    if (file === 'sudo' && args.includes('stop')) { state = 'inactive'; return ''; }
    if (file === K3S_BINARY) {
      asked += 1;
      if (opts.failsAfter !== undefined && asked > opts.failsAfter) state = 'failed';
      const when = readyAt.length > 1 ? readyAt.shift()! : readyAt[0]!;
      return `True ${at(when)}`;
    }
    return '';
  });
  return { machine, calls };
}

describe('a machine\'s own cluster', () => {
  it('starts k3s through its sudo rule and answers with a kubeconfig on its mesh address once node and DNS are ready since this start', async () => {
    const { machine, calls } = host({ readyAt: [START - 60_000, START - 60_000, START + 4000] });
    const result = await runMachineCluster(machine, { kind: 'start' });
    expect(result).toEqual({ state: 'running', meshIp: '100.64.0.7', kubeconfig: KUBECONFIG.replace('127.0.0.1', '100.64.0.7') });
    expect(calls).toContain('sudo -n systemctl start k3s');
    expect(machine.pause).toHaveBeenCalled();
  });

  it('takes a cluster already running as it is, without starting it again', async () => {
    const { machine, calls } = host({ active: 'active', readyAt: [START - 3_600_000] });
    expect(await runMachineCluster(machine, { kind: 'start' })).toMatchObject({ state: 'running' });
    expect(calls.some((call) => call.includes('systemctl start'))).toBe(false);
  });

  it('stops k3s and every container it left, and says a machine without k3s has none', async () => {
    const { machine, calls } = host({ active: 'active' });
    expect(await runMachineCluster(machine, { kind: 'stop' })).toEqual({ state: 'stopped' });
    expect(calls).toEqual(['sudo -n systemctl stop k3s', `sudo -n ${K3S_KILLALL}`, 'wanted false']);
    expect(await runMachineCluster(host({ installed: false }).machine, { kind: 'stop' })).toEqual({ state: 'absent' });
  });

  it('keeps running when asked to stop while Koala is on it, answering as a running cluster', async () => {
    const { machine, calls } = host({ active: 'active', koala: true, readyAt: [START - 3_600_000] });
    expect(await runMachineCluster(machine, { kind: 'stop' })).toMatchObject({ state: 'running', meshIp: '100.64.0.7' });
    expect(calls.some((call) => call.includes('stop') || call.includes(K3S_KILLALL))).toBe(false);
  });

  it('refuses to start without k3s or off the mesh, and fails with k3s\'s own words when its unit fails while starting', async () => {
    await expect(runMachineCluster(host({ installed: false }).machine, { kind: 'start' })).rejects.toThrow(MACHINE_CLUSTER_ABSENT);
    await expect(runMachineCluster(host({ meshIp: undefined }).machine, { kind: 'start' })).rejects.toThrow(MACHINE_OFF_MESH);
    await expect(runMachineCluster(host({ readyAt: [START - 60_000], failsAfter: 2 }).machine, { kind: 'start' })).rejects.toThrow(/no space left/);
  });

  it('takes a k3s Koala did not install as none of its own, and never starts or stops it', async () => {
    const { machine, calls } = host();
    machine.exists.mockImplementation(async (path) => path === K3S_BINARY);
    expect(await clusterState(machine)).toBe('absent');
    expect(await runMachineCluster(machine, { kind: 'stop' })).toEqual({ state: 'absent' });
    await expect(runMachineCluster(machine, { kind: 'start' })).rejects.toThrow(MACHINE_CLUSTER_ABSENT);
    expect(calls).toEqual([]);
  });

  it('reads its state, and uninstalls k3s when the machine is removed', async () => {
    expect(await clusterState(host({ installed: false }).machine)).toBe('absent');
    expect(await clusterState(host({ active: 'active' }).machine)).toBe('running');
    expect(await clusterState(host().machine)).toBe('stopped');
    const { machine, calls } = host();
    const said: string[] = [];
    await uninstallMachineCluster(machine, (line) => said.push(line));
    expect(calls).toEqual(['wanted false', `sudo -n ${K3S_UNINSTALL}`]);
    expect(said[0]).toMatch(/removed/);
  });

  it('remembers it should run, so a machine that restarted starts it again for the apps on it, and one stopped on purpose stays stopped', async () => {
    const started = host();
    await runMachineCluster(started.machine, { kind: 'start' });
    expect(started.calls.indexOf('wanted true')).toBeLessThan(started.calls.indexOf('sudo -n systemctl start k3s'));
    const rebooted = host({ wanted: true });
    const said: string[] = [];
    await startIfWanted(rebooted.machine, (line) => said.push(line));
    expect(rebooted.calls).toContain('sudo -n systemctl start k3s');
    expect(said).toHaveLength(2);
    const quiet = host({ wanted: false });
    await startIfWanted(quiet.machine, () => undefined);
    expect(quiet.calls.some((call) => call.includes('start k3s'))).toBe(false);
    const running = host({ wanted: true, active: 'active' });
    await startIfWanted(running.machine, () => undefined);
    expect(running.calls.some((call) => call.includes('start k3s'))).toBe(false);
  });

  it('on connecting, starts a cluster that should run and says how it stands, and still says how it stands when starting it failed', async () => {
    const rebooted = host({ wanted: true });
    expect(await clusterOnConnect(rebooted.machine, () => undefined)).toBe('running');
    const broken = host({ wanted: true, meshIp: undefined });
    const said: string[] = [];
    expect(await clusterOnConnect(broken.machine, (line) => said.push(line))).toBe('stopped');
    expect(said.at(-1)).toBe(`this machine's cluster could not start again: ${MACHINE_OFF_MESH}`);
    expect(await clusterOnConnect(host({ installed: false }).machine, () => undefined)).toBe('absent');
  });

  it('judges readiness only from a transition since the start, and points the kubeconfig at the mesh', () => {
    expect(readySince(`True ${at(START + 1)}`, START)).toBe(true);
    expect(readySince(`True ${at(START - 1)}`, START)).toBe(false);
    expect(readySince(`False ${at(START + 1)}`, START)).toBe(false);
    expect(readySince('', START)).toBe(false);
    expect(kubeconfigOnMesh('server: https://localhost:6443', '100.64.0.2')).toBe('server: https://100.64.0.2:6443');
  });
});
