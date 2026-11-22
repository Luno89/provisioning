export class Hopeless extends Error {}

export interface Listener<T> {
  change(state: T): void;
  broke(why: string): void;
}

export interface Subscription {
  close(): void;
}

export type Source<T> = (listener: Listener<T>) => Subscription;

export type Judged<R> = { done: R } | { waiting: string } | { hopeless: string };

export type Judge<T, R> = (state: T) => Judged<R> | Promise<Judged<R>>;

export function until<T, R>(what: string, source: Source<T>, judge: Judge<T, R>, say?: (waiting: string) => void): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    let over = false;
    let judging = false;
    let next: { state: T } | undefined;
    let said: string | undefined;
    let subscription: Subscription | undefined;
    const end = (settle: () => void): void => {
      if (over) return;
      over = true;
      subscription?.close();
      settle();
    };
    const verdict = (judged: Judged<R>): void => {
      if ('done' in judged) end(() => resolve(judged.done));
      else if ('hopeless' in judged) end(() => reject(new Hopeless(`${what}: ${judged.hopeless}`)));
      else if (judged.waiting !== said) {
        said = judged.waiting;
        say?.(judged.waiting);
      }
    };
    const failed = (err: unknown): void => end(() => reject(err));
    const drain = (): void => {
      if (judging) return;
      judging = true;
      while (next && !over) {
        const { state } = next;
        next = undefined;
        let judged: Judged<R> | Promise<Judged<R>>;
        try {
          judged = judge(state);
        } catch (err) {
          failed(err);
          break;
        }
        if (judged instanceof Promise) {
          judged.then((later) => {
            verdict(later);
            judging = false;
            drain();
          }, failed);
          return;
        }
        verdict(judged);
      }
      judging = false;
    };
    try {
      subscription = source({
        change: (state) => {
          if (over) return;
          next = { state };
          drain();
        },
        broke: (why) => end(() => reject(new Hopeless(`${what}: ${why}`))),
      });
    } catch (err) {
      end(() => reject(err));
      return;
    }
    if (over) subscription.close();
  });
}

export function joined<T>(sources: readonly Source<T>[]): Source<T[]> {
  return (listener) => {
    const latest: (T | undefined)[] = sources.map(() => undefined);
    const heard = sources.map(() => false);
    let over = false;
    const subscriptions: Subscription[] = [];
    const close = (): void => {
      over = true;
      for (const subscription of subscriptions) subscription.close();
    };
    sources.forEach((source, at) => {
      subscriptions.push(source({
        change: (state) => {
          if (over) return;
          latest[at] = state;
          heard[at] = true;
          if (heard.every(Boolean)) listener.change(latest as T[]);
        },
        broke: (why) => {
          if (over) return;
          close();
          listener.broke(why);
        },
      }));
    });
    return { close };
  };
}
