import { describe, expect, it } from 'vitest';
import type { Reopening } from '@koala/engine-core/reopening';
import { until, type Judged } from '@koala/engine-core/until';
import { informer, informers, type ClusterWatch, type Listed, type Watch } from './informer.js';

interface FakeWatch {
  path: string;
  heard(chunk: string): void;
  end(code: number, stderr?: string): void;
  stopped: boolean;
}

interface FakeCluster extends ClusterWatch {
  listed: string[];
  watched: FakeWatch[];
  opened(nth: number): Promise<FakeWatch>;
  reopened: number;
}

type Answer = string | Error;

function fakeCluster(lists: Record<string, Answer[]>): FakeCluster {
  const listed: string[] = [];
  const watched: FakeWatch[] = [];
  const waiting = new Map<number, (watch: FakeWatch) => void>();
  const cluster: FakeCluster = {
    listed,
    watched,
    reopened: 0,
    kubectl: async (args) => {
      const path = args[1]?.replace(/^--raw=/, '') ?? '';
      listed.push(path);
      const answer = lists[path.split('?')[0]!]?.shift();
      if (answer === undefined) throw new Error(`no list was scripted for ${path}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    watch: async (path, heard): Promise<Watch> => {
      let ended: (end: { code: number; stderr: string }) => void = () => undefined;
      const one: FakeWatch = { path, heard, stopped: false, end: (code, stderr = '') => ended({ code, stderr }) };
      watched.push(one);
      const promised = new Promise<{ code: number; stderr: string }>((resolve) => { ended = resolve; });
      waiting.get(watched.length)?.(one);
      return { stop: () => { one.stopped = true; ended({ code: -1, stderr: '' }); }, ended: promised };
    },
    opened: (nth) => (watched[nth - 1] ? Promise.resolve(watched[nth - 1]!) : new Promise((resolve) => { waiting.set(nth, resolve); })),
  };
  return cluster;
}

const at = (): Reopening & { taken: number } => {
  const reopen = {
    taken: 0,
    seconds: 0,
    take: () => 0,
    later: (): never => { throw new Error('the informer opens again through after()'); },
    after: async () => { reopen.taken += 1; },
    reset: () => undefined,
  };
  return reopen;
};

const PODS = '/api/v1/namespaces/koala/pods';
const pod = (name: string, version: string, phase = 'Pending') => ({ metadata: { name, namespace: 'koala', uid: `uid-${name}`, resourceVersion: version }, status: { phase } });
const list = (version: string, ...items: object[]) => JSON.stringify({ kind: 'PodList', metadata: { resourceVersion: version }, items });
const event = (type: string, object: object) => `${JSON.stringify({ type, object: { kind: 'Pod', ...object } })}\n`;

const phases = (listed: Listed) => listed.items.map((item) => `${(item.metadata as { name: string }).name}:${(item.status as { phase: string }).phase}`).sort().join(' ');
const reaching = (wanted: string, seen: string[] = []) => (listed: Listed): Judged<string> => {
  const now = phases(listed);
  seen.push(now);
  return now === wanted ? { done: now } : { waiting: now };
};

const RESOURCE = { kind: 'Pod', path: PODS, labelSelector: 'app.kubernetes.io/instance=koala' };

describe('a Kubernetes informer', () => {
  it('lists, says what is there with each item\'s kind, then watches from the list\'s version with bookmarks and says each change', async () => {
    const cluster = fakeCluster({ [PODS]: [list('10', pod('a', '9'))] });
    const seen: string[] = [];
    const done = until('pod b running', informer(cluster, RESOURCE, at()), reaching('b:Running', seen));
    const watch = await cluster.opened(1);
    expect(cluster.listed).toEqual([`${PODS}?labelSelector=app.kubernetes.io%2Finstance%3Dkoala`]);
    expect(watch.path).toBe(`${PODS}?labelSelector=app.kubernetes.io%2Finstance%3Dkoala&watch=1&allowWatchBookmarks=true&resourceVersion=10`);
    const added = event('ADDED', pod('b', '11'));
    watch.heard(added.slice(0, 20));
    watch.heard(added.slice(20) + event('MODIFIED', pod('b', '12', 'Running')));
    watch.heard(event('DELETED', pod('a', '13')));
    expect(await done).toBe('b:Running');
    expect(seen).toEqual(['a:Pending', 'a:Pending b:Pending', 'a:Pending b:Running', 'b:Running']);
    expect(watch.stopped).toBe(true);
  });

  it('stamps the kind on listed items, which the API leaves off them', async () => {
    const cluster = fakeCluster({ [PODS]: [list('1', pod('a', '1'))] });
    const kinds = await until('the pods', informer(cluster, RESOURCE, at()), (listed): Judged<unknown[]> => ({ done: listed.items.map((item) => item.kind) }));
    expect(kinds).toEqual(['Pod']);
  });

  it('watches again from the last bookmark when the API server closes the watch, without listing again or saying anything', async () => {
    const cluster = fakeCluster({ [PODS]: [list('10')] });
    const seen: string[] = [];
    const done = until('pod c', informer(cluster, RESOURCE, at()), reaching('c:Pending', seen));
    const first = await cluster.opened(1);
    first.heard(`${JSON.stringify({ type: 'BOOKMARK', object: { kind: 'Pod', metadata: { resourceVersion: '40' } } })}\n`);
    first.end(0);
    const second = await cluster.opened(2);
    expect(second.path).toMatch(/resourceVersion=40$/);
    second.heard(event('ADDED', pod('c', '41')));
    expect(await done).toBe('c:Pending');
    expect(cluster.listed).toHaveLength(1);
    expect(seen).toEqual(['', 'c:Pending']);
  });

  it('lists again when the watch says its version is gone (410), and goes on from the new list', async () => {
    const cluster = fakeCluster({ [PODS]: [list('10', pod('a', '9')), list('90', pod('a', '80', 'Running'))] });
    const done = until('pod a running', informer(cluster, RESOURCE, at()), reaching('a:Running'));
    const first = await cluster.opened(1);
    first.heard(`${JSON.stringify({ type: 'ERROR', object: { kind: 'Status', code: 410, reason: 'Expired', message: 'too old resource version: 10 (50)' } })}\n`);
    expect(await done).toBe('a:Running');
    expect(first.stopped).toBe(true);
    expect(cluster.listed).toHaveLength(2);
  });

  it('lists again when kubectl ends the watch because its version is gone', async () => {
    const cluster = fakeCluster({ [PODS]: [list('10'), list('90', pod('d', '85'))] });
    const done = until('pod d', informer(cluster, RESOURCE, at()), reaching('d:Pending'));
    (await cluster.opened(1)).end(1, 'Error from server (Gone): too old resource version: 10 (50)');
    expect(await done).toBe('d:Pending');
    expect(cluster.listed).toHaveLength(2);
  });

  it('opens the watch again through the one backoff when the cluster stops answering, from where it was', async () => {
    const cluster = fakeCluster({ [PODS]: [list('10')] });
    const reopen = at();
    const done = until('pod e', informer(cluster, RESOURCE, reopen), reaching('e:Pending'));
    (await cluster.opened(1)).end(1, 'The connection to the server 127.0.0.1:6443 was refused - did you specify the right host or port?');
    const second = await cluster.opened(2);
    expect(second.path).toMatch(/resourceVersion=10$/);
    second.heard(event('ADDED', pod('e', '11')));
    expect(await done).toBe('e:Pending');
    expect(reopen.taken).toBe(1);
  });

  it('lists again through the one backoff when the list could not reach the cluster', async () => {
    const cluster = fakeCluster({ [PODS]: [new Error('Unable to connect to the server: dial tcp 127.0.0.1:6443: connect: connection refused'), list('5', pod('f', '5'))] });
    const reopen = at();
    expect(await until('pod f', informer(cluster, RESOURCE, reopen), reaching('f:Pending'))).toBe('f:Pending');
    expect(reopen.taken).toBe(1);
  });

  it('breaks, saying why, when the cluster refuses what it asks for', async () => {
    const cluster = fakeCluster({ [PODS]: [new Error('Error from server (Forbidden): pods is forbidden: User "koala" cannot list resource "pods"')] });
    await expect(until('the pods', informer(cluster, RESOURCE, at()), reaching('never'))).rejects.toThrow('the pods: Error from server (Forbidden): pods is forbidden: User "koala" cannot list resource "pods"');
  });

  it('breaks, saying why, when the watch refuses what it asks for', async () => {
    const cluster = fakeCluster({ [PODS]: [list('1')] });
    const done = until('the pods', informer(cluster, RESOURCE, at()), reaching('never'));
    (await cluster.opened(1)).heard(`${JSON.stringify({ type: 'ERROR', object: { kind: 'Status', code: 403, message: 'pods is forbidden' } })}\n`);
    await expect(done).rejects.toThrow('the pods: pods is forbidden');
  });

  it('joins the kinds of one release, saying their items together once each has listed', async () => {
    const JOBS = '/apis/batch/v1/namespaces/koala/jobs';
    const cluster = fakeCluster({ [PODS]: [list('3', pod('a', '3', 'Running'))], [JOBS]: [JSON.stringify({ metadata: { resourceVersion: '4' }, items: [{ metadata: { name: 'seed', uid: 'uid-seed' } }] })] });
    const kinds = await until('both', informers(cluster, [RESOURCE, { kind: 'Job', path: JOBS }], at()), (listed): Judged<unknown[]> => ({ done: listed.items.map((item) => item.kind) }));
    expect(kinds).toEqual(['Pod', 'Job']);
  });
});
