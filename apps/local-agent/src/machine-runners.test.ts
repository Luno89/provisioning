import { describe, expect, it } from 'vitest';
import { recordingProcesses } from '@koala/engine-core/testing/processes';
import { runOver } from './agent-bundle.js';
import { systemInstallDeps } from './agent-install.js';
import { createLocalFsDriver } from './local-fs-driver.js';
import { hostCluster } from './machine-cluster.js';
import { meshIp } from './machine-removal.js';
import { runCommand } from './sandbox-handlers.js';

describe('the mesh address of this machine', () => {
  it('is the address tailscale reports', async () => {
    const processes = recordingProcesses(() => ({ stdout: '100.64.0.7\n' }));
    expect(await meshIp(processes)).toBe('100.64.0.7');
    expect(processes.ran).toEqual([{ command: 'tailscale', args: ['ip', '-4'] }]);
  });

  it('is none when tailscale is missing or signed out', async () => {
    expect(await meshIp(recordingProcesses(() => undefined))).toBeUndefined();
    expect(await meshIp(recordingProcesses(() => ({ code: 1, stderr: 'not logged in\n' })))).toBeUndefined();
  });
});

describe('a program the machine host runs', () => {
  it('runs inside the machine root it was given, and answers what it printed', async () => {
    const processes = recordingProcesses(() => ({ stdout: 'active\n' }));
    const host = hostCluster(async () => undefined, { machineRoot: '/srv/machine', processes });
    expect(await host.run('/usr/local/bin/k3s', ['kubectl', '--kubeconfig', '/etc/rancher/k3s/k3s.yaml', 'get', 'nodes'])).toBe('active\n');
    expect(processes.ran[0]).toMatchObject({ command: '/srv/machine/usr/local/bin/k3s', args: ['kubectl', '--kubeconfig', '/srv/machine/etc/rancher/k3s/k3s.yaml', 'get', 'nodes'] });
  });

  it('fails a program that exited badly, naming it and what it said', async () => {
    const host = hostCluster(async () => undefined, { processes: recordingProcesses(() => ({ code: 3, stderr: 'unit k3s failed\n' })) });
    await expect(host.run('systemctl', ['start', 'k3s'])).rejects.toThrow('systemctl start k3s exited 3: unit k3s failed');
  });
});

describe('a step of the agent updating itself', () => {
  it('names the step and the line npm said when it failed', async () => {
    const run = runOver(recordingProcesses(() => ({ code: 1, stderr: 'npm warn old\nnpm error code EUSAGE\nnpm error more\n' })));
    await expect(run('npm', ['ci'], '/next')).rejects.toThrow('npm ci failed: npm error code EUSAGE');
  });

  it('answers what a step printed', async () => {
    const processes = recordingProcesses(() => ({ stdout: '{"bundle":"b"}\n' }));
    expect(await runOver(processes)('/usr/bin/node', ['/next/agent.mjs', 'version'], '/next')).toBe('{"bundle":"b"}\n');
    expect(processes.ran[0]).toMatchObject({ cwd: '/next' });
  });
});

describe('installing a coding agent', () => {
  it('says unzip is not installed when it is not there', async () => {
    await expect(systemInstallDeps(recordingProcesses(() => undefined)).unzip('/a.zip', '/into')).rejects.toThrow('unzip is not installed on this machine');
  });

  it('answers what npm printed when it installed the package', async () => {
    const processes = recordingProcesses(() => ({ stdout: 'added 12 packages\n', stderr: 'npm warn\n' }));
    expect(await systemInstallDeps(processes).npm('@zed/claude-acp')).toBe('added 12 packages\nnpm warn\n');
    expect(processes.ran[0]).toMatchObject({ command: 'npm', args: ['install', '--global', '--engine-strict', '@zed/claude-acp'] });
  });
});

describe('a command a run asks this machine for', () => {
  it('says it timed out at the limit, and runs on with no limit when given none', async () => {
    const processes = recordingProcesses(() => ({ stdout: 'partway\n', runsUntilStopped: true }));
    const result = await runCommand('/work', 'sleep 100000', { timeoutMs: 1, streams: processes });
    expect(result).toEqual({ stdout: 'partway\n', stderr: '', exitCode: -1, timedOut: true });
    expect(processes.recorded[0]).toMatchObject({ run: { command: '/bin/sh', args: ['-c', 'sleep 100000'], cwd: '/work' }, io: { group: true }, stoppedWith: 'SIGTERM' });
    const quick = recordingProcesses(() => ({ stdout: 'ok\n', code: 0 }));
    expect(await runCommand('/work', 'true', { timeoutMs: 0, streams: quick })).toEqual({ stdout: 'ok\n', stderr: '', exitCode: 0, timedOut: false });
  });

  it('refuses a folder outside the machine root before running anything', async () => {
    const processes = recordingProcesses(() => ({}));
    const result = await runCommand('/work', 'ls', { subPath: '../elsewhere', streams: processes });
    expect(result).toMatchObject({ exitCode: -1, timedOut: false });
    expect(result.stderr).toContain('escapes the root directory');
    expect(processes.ran).toEqual([]);
  });
});

describe("a model's command on this machine", () => {
  it('runs in a login shell, in the folder it asked for inside the machine root, as a group', async () => {
    const processes = recordingProcesses(() => ({ stdout: 'built\n' }));
    const driver = createLocalFsDriver({ rootDir: '/home/person', deviceId: 'desk', streams: processes });
    expect(await driver.exec({ command: 'make', cwd: 'project' })).toEqual({ stdout: 'built\n', stderr: '', exitCode: 0 });
    expect(processes.recorded[0]).toMatchObject({ run: { command: '/bin/bash', args: ['-lc', 'make'], cwd: '/home/person/project' }, io: { group: true } });
  });
});
