import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordingProcesses, type Script } from '@koala/engine-core/testing/processes';
import { CommandFailedError } from '../../platform/index.js';
import { mock } from 'vitest-mock-extended';
import { InfrastructureService, TerraformStopped } from './InfrastructureService.js';
import type { StateLocks } from './StateLocks.js';

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

async function infra(script: Script) {
  const root = await mkdtemp(path.join(tmpdir(), 'koala-infra-unit-'));
  folders.push(root);
  const processes = recordingProcesses(script);
  const service = new InfrastructureService({ cdktfDir: path.join(root, 'app'), stateDir: path.join(root, 'state'), logDir: path.join(root, 'logs'), home: { kind: 'local', dir: path.join(root, 'state') } }, processes);
  return { service, processes, logFile: path.join(root, 'logs', 'run.log') };
}

const socketRoom = () => {
  const said: string[] = [];
  return { said, io: { to: () => ({ emit: (_event: string, chunk: string) => { said.push(chunk); } }) } as never };
};

describe('a command Koala runs for a stack', () => {
  it('writes what it prints to the log and the resource\'s room, and hands back what it printed', async () => {
    const { service, processes, logFile } = await infra(() => ({ stdout: 'planned\n', stderr: 'warned\n' }));
    const room = socketRoom();
    expect(await service.runCommand('terraform', ['plan'], 'desk', { logFile, io: room.io, resourceId: 'desk' })).toEqual({ stdout: 'planned\n', logFile });
    expect(room.said.sort()).toEqual(['planned\n', 'warned\n']);
    expect((await readFile(logFile, 'utf8')).split('\n').filter(Boolean).sort()).toEqual(['planned', 'warned']);
    const [run] = processes.ran;
    expect(run?.env?.['PATH']?.split(':').at(-1)).toMatch(/\/bin$/);
    expect(run?.env?.['CDKTF_DISABLE_PLUGIN_CACHE_ENV']).toBe('true');
  });

  it('fails with its exit code and says so in the log', async () => {
    const { service, logFile } = await infra(() => ({ stderr: 'no such stack\n', code: 2 }));
    const failure = await service.runCommand('terraform', ['apply'], 'desk', { logFile }).then(() => undefined, (err: unknown) => err);
    expect(failure).toBeInstanceOf(CommandFailedError);
    expect((failure as CommandFailedError).exitCode).toBe(2);
    expect(await readFile(logFile, 'utf8')).toContain('--- EXECUTION FAILED (Exit Code 2) ---');
  });

  it('interrupts the command and everything it started when told to stop, saying why', async () => {
    let begin: () => void = () => undefined;
    const begun = new Promise<void>((done) => { begin = done; });
    const { service, processes, logFile } = await infra(() => { begin(); return { runsUntilStopped: true }; });
    const stop = new AbortController();
    const running = service.runCommand('npx', ['cdktf', 'deploy'], 'desk', { logFile, signal: stop.signal }).then(() => undefined, (err: unknown) => err);
    await begun;
    stop.abort(new Error('the person stopped the deploy'));
    const ended = await running;
    expect(ended).toBeInstanceOf(TerraformStopped);
    expect((ended as Error).message).toBe('Terraform was stopped: the person stopped the deploy');
    expect(processes.recorded).toMatchObject([{ io: { group: true }, stoppedWith: 'SIGINT' }]);
    expect(await readFile(logFile, 'utf8')).toContain('STOPPED: the person stopped the deploy');
  });
});

describe('a stack whose state is kept in the cluster', () => {
  async function inCluster(locks: StateLocks | undefined, script: Script = () => ({ stdout: 'applied\n' })) {
    const root = await mkdtemp(path.join(tmpdir(), 'koala-infra-unit-'));
    folders.push(root);
    const processes = recordingProcesses(script);
    const places = { cdktfDir: path.join(root, 'app'), stateDir: path.join(root, 'state'), logDir: path.join(root, 'logs'), runsDir: root, home: { kind: 'kubernetes' as const, namespace: 'nowrinkles', api: { host: '10.43.0.1', port: '443' }, dir: path.join(root, 'state') } };
    return { service: new InfrastructureService(places, processes, locks), processes, logFile: path.join(root, 'logs', 'run.log') };
  }

  it('frees the lock a killed run left on it before Terraform takes it, saying whose it was', async () => {
    const order: string[] = [];
    const locks = mock<StateLocks>();
    locks.freeLeftBehind.mockImplementation(async (namespace, stack, applyingHere) => {
      order.push(`free ${namespace} ${stack} ${String(applyingHere)}`);
      return { id: '1849cacd', who: 'node@instance-worker-cluster-old', host: 'instance-worker-cluster-old' };
    });
    const { service, logFile } = await inCluster(locks, (run) => { order.push(run.args.slice(0, 3).join(' ')); return { stdout: 'applied\n' }; });
    await service.deploy('platform-egress', { logFile });
    expect(order).toEqual(['free nowrinkles platform-egress false', 'cdktf deploy platform-egress']);
    expect(await readFile(logFile, 'utf8')).toContain('the state of platform-egress was still locked (1849cacd) by node@instance-worker-cluster-old, whose run is gone; Koala freed it');
  });

  it('leaves the lock of a stack this process is applying right now to that run', async () => {
    const seen: boolean[] = [];
    const locks = mock<StateLocks>();
    locks.freeLeftBehind.mockImplementation(async (_namespace, _stack, applyingHere) => { seen.push(applyingHere); return undefined; });
    let calls = 0;
    const { service, logFile } = await inCluster(locks, () => (++calls === 1 ? { runsUntilStopped: true } : { stdout: 'applied\n' }));
    const stop = new AbortController();
    const first = service.deploy('platform-egress', { logFile, signal: stop.signal }).catch(() => undefined);
    while (calls === 0) await new Promise((done) => { setImmediate(done); });
    await service.deploy('platform-egress', { logFile });
    stop.abort(new Error('done'));
    await first;
    expect(seen).toEqual([false, true]);
  });

  it('refuses to apply when it was given no way to free a lock a killed run left', async () => {
    const { service, processes, logFile } = await inCluster(undefined);
    await expect(service.deploy('platform-egress', { logFile })).rejects.toThrow('keeps the state of platform-egress in the cluster but was given no way to free a lock a killed run left there');
    expect(processes.ran).toEqual([]);
  });
});
