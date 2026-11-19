import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Followed, ProcessResult } from '../../platform/index.js';
import type { ClusterAccess } from './ClusterAccess.js';
import { PodLogTails } from './PodLogTails.js';

function followed() {
  let end: (result: ProcessResult) => void = () => undefined;
  let fail: (err: Error) => void = () => undefined;
  const stops: string[] = [];
  const ended = new Promise<ProcessResult>((done, failed) => { end = done; fail = failed; });
  const handle: Followed = { pid: undefined, stop: () => { stops.push('stopped'); }, exited: ended, ended };
  return { handle, stops, end: (result: ProcessResult) => end(result), fail: (err: Error) => fail(err) };
}

function tails() {
  const access = mock<Pick<ClusterAccess, 'follow'>>();
  const said: [string, string][] = [];
  const logged: string[] = [];
  const service = new PodLogTails({ access, say: (room, text) => said.push([room, text]), log: (message) => logged.push(message) });
  return { access, said, logged, service };
}

const POD = { resourceId: 'shop', clusterId: 'machine-desk', namespace: 'shop-1a2b3c', podName: 'shop-0' };
const settle = () => new Promise((done) => setImmediate(done));

describe('following a pod\'s logs', () => {
  it('follows them through ClusterAccess on the app\'s cluster and says each chunk in the app\'s log room', async () => {
    const { access, said, service } = tails();
    const one = followed();
    access.follow.mockImplementation(async (_target, _args, onOutput) => { onOutput('started\n'); return one.handle; });
    await service.tail(POD);
    expect(access.follow).toHaveBeenCalledWith('machine-desk', ['logs', '-n', 'shop-1a2b3c', 'shop-0', '--all-containers=true', '--tail=100', '-f'], expect.any(Function));
    expect(said).toEqual([['shop-kube', 'started\n']]);
    expect(service.following('shop')).toBe(true);
  });

  it('stops the last tail of the same app before following again, and says nothing when a stopped one ends', async () => {
    const { access, said, service } = tails();
    const first = followed();
    const second = followed();
    access.follow.mockResolvedValueOnce(first.handle).mockResolvedValueOnce(second.handle);
    await service.tail(POD);
    await service.tail({ ...POD, podName: 'shop-1' });
    expect(first.stops).toEqual(['stopped']);
    first.end({ code: 143, stdout: '', stderr: '' });
    await settle();
    expect(said).toEqual([]);
    expect(service.following('shop')).toBe(true);
  });

  it('stops when asked, and forgets the tail', async () => {
    const { access, service } = tails();
    const one = followed();
    access.follow.mockResolvedValue(one.handle);
    await service.tail(POD);
    service.stop('shop');
    service.stop('shop');
    expect(one.stops).toEqual(['stopped']);
    expect(service.following('shop')).toBe(false);
  });

  it('says why in the room when kubectl ends with an error of its own', async () => {
    const { access, said, service } = tails();
    const one = followed();
    access.follow.mockResolvedValue(one.handle);
    await service.tail(POD);
    one.end({ code: 1, stdout: '', stderr: 'Error from server (NotFound): pods "shop-0" not found\n' });
    await settle();
    expect(said).toEqual([['shop-kube', 'Error from server (NotFound): pods "shop-0" not found']]);
    expect(service.following('shop')).toBe(false);
  });

  it('says the exit code when kubectl ends with an error and nothing on stderr', async () => {
    const { access, said, service } = tails();
    const one = followed();
    access.follow.mockResolvedValue(one.handle);
    await service.tail(POD);
    one.end({ code: 2, stdout: '', stderr: '' });
    await settle();
    expect(said).toEqual([['shop-kube', 'the logs of shop-0 stopped (exit 2)']]);
  });

  it('says nothing more when the logs end cleanly', async () => {
    const { access, said, service } = tails();
    const one = followed();
    access.follow.mockResolvedValue(one.handle);
    await service.tail(POD);
    one.end({ code: 0, stdout: '', stderr: '' });
    await settle();
    expect(said).toEqual([]);
    expect(service.following('shop')).toBe(false);
  });

  it('says and logs why when kubectl could not be started', async () => {
    const { access, said, logged, service } = tails();
    const one = followed();
    access.follow.mockResolvedValue(one.handle);
    await service.tail(POD);
    one.fail(new Error('spawn kubectl ENOENT'));
    await settle();
    expect(said).toEqual([['shop-kube', 'the logs of shop-0 could not be followed: spawn kubectl ENOENT']]);
    expect(logged).toEqual(['[pod-logs] shop: spawn kubectl ENOENT']);
    expect(service.following('shop')).toBe(false);
  });

  it('says ClusterAccess\'s refusal in the room and fails with it when the cluster cannot be reached, following nothing', async () => {
    const { access, said, service } = tails();
    access.follow.mockRejectedValue(new Error('machine-desk is stopped until something runs on it'));
    await expect(service.tail(POD)).rejects.toThrow('machine-desk is stopped until something runs on it');
    expect(said).toEqual([['shop-kube', 'the logs of shop-0 could not be followed: machine-desk is stopped until something runs on it']]);
    expect(service.following('shop')).toBe(false);
  });
});
