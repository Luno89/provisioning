import { describe, expect, it } from 'vitest';
import { Hopeless, joined, until, type Judged, type Listener, type Source } from './until.js';

interface Pushed<T> extends Source<T> {
  push(state: T): void;
  broke(why: string): void;
  closed(): boolean;
  opened(): number;
}

function pushed<T>(current?: T): Pushed<T> {
  let listener: Listener<T> | undefined;
  let closed = false;
  let opened = 0;
  const source = ((heard: Listener<T>) => {
    opened += 1;
    listener = heard;
    if (current !== undefined) heard.change(current);
    return { close: () => { closed = true; } };
  }) as Pushed<T>;
  source.push = (state) => listener?.change(state);
  source.broke = (why) => listener?.broke(why);
  source.closed = () => closed;
  source.opened = () => opened;
  return source;
}

const atLeast = (wanted: number) => (count: number): Judged<number> => (count >= wanted ? { done: count } : { waiting: `${count} of ${wanted}` });

describe('waiting until a source says what is waited for', () => {
  it('is done at once when the current state already is, and lets the source go', async () => {
    const source = pushed(3);
    expect(await until('three', source, atLeast(3))).toBe(3);
    expect(source.closed()).toBe(true);
  });

  it('judges each pushed change, says each new thing it waits on once, and ends on the change that is done', async () => {
    const source = pushed(0);
    const said: string[] = [];
    const done = until('two replicas', source, atLeast(2), (waiting) => said.push(waiting));
    source.push(0);
    source.push(1);
    source.push(2);
    expect(await done).toBe(2);
    expect(said).toEqual(['0 of 2', '1 of 2']);
    expect(source.closed()).toBe(true);
  });

  it('ends Hopeless, saying what it waited for and why, the moment a change can never become done', async () => {
    const source = pushed('starting');
    const done = until('the backend', source, (state): Judged<string> => (state === 'refused' ? { hopeless: 'its image cannot be pulled' } : { waiting: state }));
    source.push('refused');
    const failed = await done.then(() => undefined, (err: unknown) => err);
    expect(failed).toBeInstanceOf(Hopeless);
    expect((failed as Error).message).toBe('the backend: its image cannot be pulled');
    expect(source.closed()).toBe(true);
  });

  it('ends Hopeless when its source can never tell it more', async () => {
    const source = pushed(0);
    const done = until('the pods', source, atLeast(1));
    source.broke('the cluster refuses this account the pods');
    await expect(done).rejects.toThrow(new Hopeless('the pods: the cluster refuses this account the pods'));
    expect(source.closed()).toBe(true);
  });

  it('judges only the latest state when changes come while a judgement is still being made, and never two at once', async () => {
    const source = pushed(0);
    const judged: number[] = [];
    let busy = 0;
    let most = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const done = until('five', source, async (count) => {
      busy += 1;
      most = Math.max(most, busy);
      judged.push(count);
      if (count === 0) await held;
      busy -= 1;
      return atLeast(5)(count);
    });
    source.push(1);
    source.push(2);
    source.push(5);
    release();
    expect(await done).toBe(5);
    expect(judged).toEqual([0, 5]);
    expect(most).toBe(1);
  });

  it('fails with the judge\'s own error when judging fails', async () => {
    const mistake = new TypeError('the judge read a field that is not there');
    await expect(until('it', pushed(1), () => { throw mistake; })).rejects.toBe(mistake);
  });

  it('hears nothing more once it ended', async () => {
    const source = pushed(1);
    let judgedAfter = 0;
    await until('one', source, (count) => {
      if (count !== 1) judgedAfter += 1;
      return atLeast(1)(count);
    });
    source.push(7);
    source.broke('late');
    expect(judgedAfter).toBe(0);
  });
});

describe('sources joined into one', () => {
  it('says nothing until every source has said its state, then each change with the latest of all', async () => {
    const pods = pushed<string>();
    const jobs = pushed<string>();
    const seen: string[][] = [];
    const done = until('both', joined([pods, jobs]), (states): Judged<string[]> => {
      seen.push([...states]);
      return states.every((state) => state === 'ready') ? { done: states } : { waiting: states.join(', ') };
    });
    pods.push('starting');
    jobs.push('running');
    pods.push('ready');
    jobs.push('ready');
    expect(await done).toEqual(['ready', 'ready']);
    expect(seen).toEqual([['starting', 'running'], ['ready', 'running'], ['ready', 'ready']]);
    expect(pods.closed() && jobs.closed()).toBe(true);
  });

  it('breaks when any one of them breaks', async () => {
    const pods = pushed('a');
    const jobs = pushed('b');
    const done = until('both', joined([pods, jobs]), (): Judged<true> => ({ waiting: 'on' }));
    jobs.broke('jobs are refused');
    await expect(done).rejects.toThrow('both: jobs are refused');
    expect(pods.closed() && jobs.closed()).toBe(true);
  });
});
