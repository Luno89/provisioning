import { describe, expect, it } from 'vitest';
import { IdleGate } from './idle-gate.js';
import { SelfUpdate, bundleIn, bundleNamed, serviceManagerOf, updateWanted, type SelfUpdateDeps, type UpdateReport } from './self-update.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

describe('which agent this is, and whether Koala names another', () => {
  it('reads its own bundle from the file the install wrote, and nothing else', () => {
    expect(bundleIn(`${A}\n`)).toBe(A);
    expect(bundleIn(`${A.toUpperCase()}  machine-agent.tgz\n`)).toBe(A);
    expect(bundleIn('not a checksum')).toBeUndefined();
    expect(bundleIn(undefined)).toBeUndefined();
  });

  it('takes only a well-formed sha256 from Koala', () => {
    expect(bundleNamed({ sha256: B })).toBe(B);
    expect(bundleNamed({ sha256: 'b'.repeat(63) })).toBeUndefined();
    expect(bundleNamed({ sha256: 42 })).toBeUndefined();
    expect(bundleNamed(undefined)).toBeUndefined();
  });

  it('wants an update only when it knows its own bundle and Koala names a different one', () => {
    expect(updateWanted(A, B)).toBe(true);
    expect(updateWanted(A, A)).toBe(false);
    expect(updateWanted(undefined, B)).toBe(false);
    expect(updateWanted(A, undefined)).toBe(false);
  });
});

describe('an agent restarts itself only under the service the install made', () => {
  const cgroup = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/koala-machine.service\n';

  it('is under systemd when systemd started it as koala-machine.service', () => {
    expect(serviceManagerOf('linux', { INVOCATION_ID: 'x' }, cgroup)).toBe('systemd');
  });

  it('is not when a shell started it, even one systemd started for something else', () => {
    expect(serviceManagerOf('linux', {}, cgroup)).toBeUndefined();
    expect(serviceManagerOf('linux', { INVOCATION_ID: 'x' }, '0::/user.slice/user-1000.slice/user@1000.service/app.slice/gnome-terminal-server.service\n')).toBeUndefined();
    expect(serviceManagerOf('linux', { INVOCATION_ID: 'x' }, undefined)).toBeUndefined();
  });

  it('is under launchd only as the dev.koala.machine job, not from a terminal', () => {
    expect(serviceManagerOf('darwin', { XPC_SERVICE_NAME: 'dev.koala.machine' }, undefined)).toBe('launchd');
    expect(serviceManagerOf('darwin', { XPC_SERVICE_NAME: '0' }, undefined)).toBeUndefined();
    expect(serviceManagerOf('win32', { INVOCATION_ID: 'x' }, cgroup)).toBeUndefined();
  });
});

interface Harness {
  updates: SelfUpdate;
  gate: IdleGate;
  reports: UpdateReport[];
  lines: string[];
  steps: string[];
  prepared: (() => void)[];
  failPrepare: (bundle: string) => Error | undefined;
}

function harness(over: Partial<SelfUpdateDeps> = {}): Harness {
  const gate = new IdleGate();
  const h: Harness = { gate, reports: [], lines: [], steps: [], prepared: [], failPrepare: () => undefined } as unknown as Harness;
  h.updates = new SelfUpdate({
    own: A,
    service: 'systemd',
    gate,
    prepare: (bundle) => {
      h.steps.push(`prepare ${bundle[0]}`);
      const failure = h.failPrepare(bundle);
      if (failure) return Promise.reject(failure);
      return new Promise<void>((resolve) => { h.prepared.push(resolve); });
    },
    discard: async () => { h.steps.push('discard'); },
    swap: () => { h.steps.push(`swap while ${gate.idle ? 'idle' : 'busy'}`); },
    restart: (bundle) => { h.steps.push(`restart ${bundle[0]}`); },
    report: (report) => h.reports.push(report),
    log: (line) => h.lines.push(line),
    ...over,
  });
  return h;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('an agent Koala names a newer bundle to', () => {
  it('does nothing when it already runs the bundle Koala names', async () => {
    const h = harness();
    await h.updates.named({ sha256: A });
    expect(h.steps).toEqual([]);
    expect(h.reports).toEqual([]);
  });

  it('updates at once when idle: prepares, swaps, then restarts', async () => {
    const h = harness();
    const done = h.updates.named({ sha256: B });
    await settle();
    expect(h.reports.map((r) => r.state)).toEqual(['updating']);
    h.prepared.shift()!();
    await done;
    expect(h.steps).toEqual(['prepare b', 'swap while idle', 'restart b']);
  });

  it('waits while work runs, keeps taking it, and updates at the moment the machine is idle', async () => {
    const h = harness();
    const release = h.gate.hold('a session of gemini');
    const done = h.updates.named({ sha256: B });
    await settle();
    expect(h.steps).toEqual([]);
    expect(h.reports).toEqual([{ state: 'waiting', bundle: B, busyWith: ['a session of gemini'] }]);
    const another = h.gate.hold('a tool call');
    release();
    await settle();
    expect(h.steps).toEqual([]);
    another();
    await settle();
    expect(h.steps).toEqual(['prepare b']);
    h.prepared.shift()!();
    await done;
    expect(h.steps).toEqual(['prepare b', 'swap while idle', 'restart b']);
  });

  it('never swaps while work that arrived during the preparation runs', async () => {
    const h = harness();
    const done = h.updates.named({ sha256: B });
    await settle();
    const arrived = h.gate.hold('a tool call');
    h.prepared.shift()!();
    await settle();
    expect(h.steps).toEqual(['prepare b']);
    expect(h.reports.at(-1)).toEqual({ state: 'waiting', bundle: B, busyWith: ['a tool call'] });
    arrived();
    await done;
    expect(h.steps).toEqual(['prepare b', 'swap while idle', 'restart b']);
  });

  it('keeps running as it is when a step fails, says why, and tries again only when Koala names a bundle again', async () => {
    const h = harness();
    h.failPrepare = () => new Error('the agent Koala sent is not the one it named');
    await h.updates.named({ sha256: B });
    expect(h.steps).toEqual(['prepare b']);
    expect(h.reports.at(-1)).toEqual({ state: 'failed', bundle: B, reason: 'the agent Koala sent is not the one it named' });
    expect(h.lines.some((line) => line.includes('keeps running as it is: the agent Koala sent is not the one it named'))).toBe(true);
    await settle();
    expect(h.steps).toEqual(['prepare b']);
    h.failPrepare = () => undefined;
    const again = h.updates.named({ sha256: B });
    await settle();
    h.prepared.shift()!();
    await again;
    expect(h.steps).toEqual(['prepare b', 'prepare b', 'swap while idle', 'restart b']);
  });

  it('puts the running agent back and says so when the swap fails', async () => {
    const h = harness({ swap: () => { throw new Error('EXDEV'); } });
    const done = h.updates.named({ sha256: B });
    await settle();
    h.prepared.shift()!();
    await done;
    expect(h.steps).toEqual(['prepare b', 'discard']);
    expect(h.reports.at(-1)?.state).toBe('failed');
    expect(h.reports.at(-1)?.reason).toContain('EXDEV');
  });

  it('follows the newest bundle when Koala names another while one is being prepared', async () => {
    const h = harness();
    const done = h.updates.named({ sha256: B });
    await settle();
    await h.updates.named({ sha256: C });
    h.prepared.shift()!();
    await settle();
    expect(h.steps).toEqual(['prepare b', 'discard', 'prepare c']);
    h.prepared.shift()!();
    await done;
    expect(h.steps).toEqual(['prepare b', 'discard', 'prepare c', 'swap while idle', 'restart c']);
  });

  it('tells Koala again where it is when named the same bundle while waiting', async () => {
    const h = harness();
    h.gate.hold('a command');
    void h.updates.named({ sha256: B });
    await settle();
    await h.updates.named({ sha256: B });
    expect(h.reports).toEqual([
      { state: 'waiting', bundle: B, busyWith: ['a command'] },
      { state: 'waiting', bundle: B, busyWith: ['a command'] },
    ]);
    expect(h.steps).toEqual([]);
  });

  it('started outside its service, changes nothing and says once how to get the newer agent', async () => {
    const h = harness({ service: undefined });
    await h.updates.named({ sha256: B });
    await h.updates.named({ sha256: B });
    expect(h.steps).toEqual([]);
    expect(h.reports).toEqual([{ state: 'not-a-service', bundle: B }, { state: 'not-a-service', bundle: B }]);
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toContain('run the command from My Machines again');
  });

  it('does not update an agent that cannot say which bundle it is', async () => {
    const h = harness({ own: undefined });
    await h.updates.named({ sha256: B });
    expect(h.steps).toEqual([]);
    expect(h.reports).toEqual([]);
  });
});
