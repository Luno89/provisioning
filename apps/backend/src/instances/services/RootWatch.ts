import { WATCH_EVERY_MS, isDown, nextReach, rootReachPush, type Reach } from '../lib/instance-watch.js';
import { PendingProbes } from './PendingProbes.js';

export interface RootReachView {
  rootUrl: string;
  reachable: boolean;
  down: boolean;
  unreachableSince?: string | undefined;
  lastSeenAt?: string | undefined;
}

export interface RootWatchDeps {
  rootUrl: string;
  ownerId: string;
  probe: (url: string) => Promise<boolean>;
  tell: (ownerId: string, message: { title: string; body: string; path: string; tag: string }) => Promise<unknown>;
  afterMs: number;
  everyMs?: number | undefined;
  now?: () => Date;
  log?: (message: string) => void;
}

export const rootProbeUrl = (rootUrl: string): string => `${rootUrl.replace(/\/+$/, '')}/api/identity/keys`;

export class RootWatch {
  private readonly probes = new PendingProbes();
  private reach: Reach | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: RootWatchDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.pass().catch((err: Error) => this.log(`[root-watch] ${err.message}`)); }, this.deps.everyMs ?? WATCH_EVERY_MS);
    this.timer.unref();
    this.pass().catch((err: Error) => this.log(`[root-watch] ${err.message}`));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private log(message: string): void {
    (this.deps.log ?? console.warn)(message);
  }

  view(): RootReachView {
    return {
      rootUrl: this.deps.rootUrl,
      reachable: this.reach?.reachable ?? true,
      down: isDown(this.reach),
      ...(this.reach?.unreachableSince ? { unreachableSince: this.reach.unreachableSince } : {}),
      ...(this.reach?.lastSeenAt ? { lastSeenAt: this.reach.lastSeenAt } : {}),
    };
  }

  async pass(): Promise<void> {
    const answered = this.probes.answered('root');
    if (answered !== undefined) {
      const now = (this.deps.now ?? (() => new Date()))();
      const { reach, tell } = nextReach(this.reach, answered, now, this.deps.afterMs);
      this.reach = reach;
      if (tell) {
        const message = rootReachPush(tell, this.deps.rootUrl, reach, now);
        await this.deps.tell(this.deps.ownerId, { ...message, path: '/#/infrastructure', tag: 'koala-root' })
          .catch((err: Error) => this.log(`[root-watch] could not tell the owner: ${err.message}`));
      }
    }
    this.probes.ask('root', () => this.deps.probe(rootProbeUrl(this.deps.rootUrl)));
  }
}
