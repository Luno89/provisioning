import type { InstanceRecord } from './instances.js';
import { inService } from './instances.js';

export const DEFAULT_UNREACHABLE_MINUTES = 10;
export const PRESENCE_NAMESPACE = '/instances';
export const PRESENCE_RETRY_MS = 5_000;

export interface Reach {
  reachable: boolean;
  lastSeenAt?: string | undefined;
  unreachableSince?: string | undefined;
  toldDown?: boolean | undefined;
}

export type Tell = 'down' | 'back';

export interface InstanceWatchRecord {
  instanceId: string;
  reach?: Reach | undefined;
  notifyWhenUnreachable?: boolean | undefined;
  presence?: boolean | undefined;
}

export function unreachableAfterMs(env: Readonly<Record<string, string | undefined>>): number {
  const minutes = Number(env.WATCH_UNREACHABLE_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_UNREACHABLE_MINUTES) * 60_000;
}

export function nextReach(previous: Reach | undefined, answered: boolean, now: Date, afterMs: number): { reach: Reach; tell?: Tell } {
  const at = now.toISOString();
  if (answered) return { reach: { reachable: true, lastSeenAt: at }, ...(previous?.toldDown ? { tell: 'back' as const } : {}) };
  const since = previous?.unreachableSince ?? at;
  const down = now.getTime() - Date.parse(since) >= afterMs;
  const tell = down && !previous?.toldDown ? 'down' as const : undefined;
  return {
    reach: {
      reachable: false,
      ...(previous?.lastSeenAt ? { lastSeenAt: previous.lastSeenAt } : {}),
      unreachableSince: since,
      ...(previous?.toldDown || tell ? { toldDown: true } : {}),
    },
    ...(tell ? { tell } : {}),
  };
}

export function reachAtStart(previous: Reach | undefined, now: Date): Reach {
  if (previous?.toldDown && !previous.reachable) return previous;
  return {
    reachable: false,
    ...(previous?.lastSeenAt ? { lastSeenAt: previous.lastSeenAt } : {}),
    unreachableSince: now.toISOString(),
  };
}

export function graceLeftMs(reach: Reach | undefined, now: Date, afterMs: number): number | undefined {
  if (!reach || reach.reachable || reach.toldDown || !reach.unreachableSince) return undefined;
  return Math.max(0, Date.parse(reach.unreachableSince) + afterMs - now.getTime());
}

export const isDown = (reach: Reach | undefined): boolean => reach?.toldDown === true && reach.reachable === false;

export const watched = (instance: InstanceRecord, watch: Pick<InstanceWatchRecord, 'presence'> | undefined): boolean =>
  inService(instance) && instance.status !== 'paused' && watch?.presence === true;

export function presenceAuth(raw: unknown): { instanceId: string; token: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { instanceId, token } = raw as Record<string, unknown>;
  return typeof instanceId === 'string' && instanceId && typeof token === 'string' && token ? { instanceId, token } : undefined;
}

export const tellsOwner = (instance: Pick<InstanceRecord, 'pool'>, watch: Pick<InstanceWatchRecord, 'notifyWhenUnreachable'> | undefined): boolean =>
  Boolean(instance.pool) || watch?.notifyWhenUnreachable !== false;

export const tellsOperator = (instance: Pick<InstanceRecord, 'pool'>): boolean => Boolean(instance.pool);

const minutesSince = (since: string | undefined, now: Date): number =>
  since ? Math.max(1, Math.round((now.getTime() - Date.parse(since)) / 60_000)) : 0;

const named = (instance: Pick<InstanceRecord, 'id' | 'name'>): string => instance.name ? `${instance.name} (${instance.id})` : instance.id;

export function instanceReachMail(
  tell: Tell,
  instance: Pick<InstanceRecord, 'id' | 'name' | 'pool' | 'url'>,
  reach: Reach,
  now: Date,
  toOperator = false,
): { subject: string; text: string } {
  const who = named(instance);
  const where = instance.pool ? 'on Koala\'s servers' : 'on its own machine';
  if (tell === 'down') {
    const minutes = minutesSince(reach.unreachableSince, now);
    const cause = instance.pool
      ? 'It runs on Koala\'s servers, so this is ours to look at.'
      : 'It runs on its owner\'s own machine: that machine may be off, asleep or offline.';
    return {
      subject: `${toOperator ? 'An instance' : 'Your instance'} ${who} has not answered for ${minutes} minutes`,
      text: `${who} ${where} has not been in touch with root for ${minutes} minutes${reach.lastSeenAt ? `; it was last in touch at ${reach.lastSeenAt}` : ''}. ${cause} Root says so once when it is back.${toOperator || instance.pool ? '' : ' You can switch these emails off in your instance\'s Settings → Notifications.'}`,
    };
  }
  return {
    subject: `${toOperator ? 'Instance' : 'Your instance'} ${who} answers again`,
    text: `${who} ${where} is in touch with root again since ${now.toISOString()}.`,
  };
}

export function rootReachPush(tell: Tell, rootUrl: string, reach: Reach, now: Date): { title: string; body: string } {
  if (tell === 'down') {
    const minutes = minutesSince(reach.unreachableSince, now);
    return {
      title: 'Koala\'s root is not answering',
      body: `Your instance has not reached ${rootUrl} for ${minutes} minutes, so signing in and your addresses may not work. Your instance keeps running and says so when root answers again.`,
    };
  }
  return { title: 'Koala\'s root answers again', body: `Your instance reaches ${rootUrl} again.` };
}
