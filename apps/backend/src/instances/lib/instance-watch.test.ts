import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UNREACHABLE_MINUTES, graceLeftMs, instanceReachMail, isDown, nextReach, presenceAuth, reachAtStart, rootReachPush, tellsOperator, tellsOwner, unreachableAfterMs, watched,
} from './instance-watch.js';
import type { InstanceRecord } from './instances.js';

const TEN = 10 * 60_000;
const at = (minutes: number) => new Date(Date.parse('2026-10-29T10:00:00Z') + minutes * 60_000);

describe('one instance watched over time', () => {
  it('stays quiet until it has not answered for the whole threshold, then tells once', () => {
    let step = nextReach(undefined, true, at(0), TEN);
    expect(step).toEqual({ reach: { reachable: true, lastSeenAt: at(0).toISOString() } });
    step = nextReach(step.reach, false, at(1), TEN);
    expect(step.tell).toBeUndefined();
    expect(step.reach).toEqual({ reachable: false, lastSeenAt: at(0).toISOString(), unreachableSince: at(1).toISOString() });
    step = nextReach(step.reach, false, at(10), TEN);
    expect(step.tell).toBeUndefined();
    step = nextReach(step.reach, false, at(11), TEN);
    expect(step.tell).toBe('down');
    expect(isDown(step.reach)).toBe(true);
    step = nextReach(step.reach, false, at(30), TEN);
    expect(step.tell).toBeUndefined();
    expect(step.reach.unreachableSince).toBe(at(1).toISOString());
  });

  it('says once that it is back, and only after it was told down', () => {
    const down = nextReach(nextReach(undefined, false, at(0), TEN).reach, false, at(10), TEN);
    expect(down.tell).toBe('down');
    const back = nextReach(down.reach, true, at(12), TEN);
    expect(back.tell).toBe('back');
    expect(back.reach).toEqual({ reachable: true, lastSeenAt: at(12).toISOString() });
    expect(nextReach(back.reach, true, at(13), TEN).tell).toBeUndefined();
    const blip = nextReach(nextReach(back.reach, false, at(14), TEN).reach, true, at(15), TEN);
    expect(blip.tell).toBeUndefined();
  });

  it('counts the grace left from when it went, and none once told or present', () => {
    const gone = nextReach({ reachable: true, lastSeenAt: at(0).toISOString() }, false, at(1), TEN).reach;
    expect(graceLeftMs(gone, at(4), TEN)).toBe(7 * 60_000);
    expect(graceLeftMs(gone, at(20), TEN)).toBe(0);
    expect(graceLeftMs({ reachable: true }, at(4), TEN)).toBeUndefined();
    expect(graceLeftMs({ ...gone, toldDown: true }, at(20), TEN)).toBeUndefined();
    expect(graceLeftMs(undefined, at(4), TEN)).toBeUndefined();
  });

  it('gives every instance the whole grace again when root starts, keeping one already told down', () => {
    const stale = { reachable: false, lastSeenAt: at(0).toISOString(), unreachableSince: at(1).toISOString() };
    expect(reachAtStart(stale, at(60))).toEqual({ reachable: false, lastSeenAt: at(0).toISOString(), unreachableSince: at(60).toISOString() });
    expect(reachAtStart({ reachable: true, lastSeenAt: at(0).toISOString() }, at(60)).unreachableSince).toBe(at(60).toISOString());
    const told = { ...stale, toldDown: true };
    expect(reachAtStart(told, at(60))).toBe(told);
    expect(reachAtStart(undefined, at(60))).toEqual({ reachable: false, unreachableSince: at(60).toISOString() });
  });

  it('reads the threshold from the environment, ten minutes by default', () => {
    expect(unreachableAfterMs({})).toBe(DEFAULT_UNREACHABLE_MINUTES * 60_000);
    expect(unreachableAfterMs({ WATCH_UNREACHABLE_MINUTES: '2' })).toBe(120_000);
    expect(unreachableAfterMs({ WATCH_UNREACHABLE_MINUTES: 'soon' })).toBe(TEN);
    expect(unreachableAfterMs({ WATCH_UNREACHABLE_MINUTES: '0' })).toBe(TEN);
  });
});

describe('which instances root watches and whom it tells', () => {
  const base: InstanceRecord = { id: 'inst-a', ownerId: 'o', url: 'https://a.example', createdAt: '', updatedAt: '', status: 'ready', meshIp: '100.64.0.9', name: 'a' };

  it('watches an instance in service that has connected, mesh or not, never a stopped or waiting one', () => {
    const present = { presence: true };
    expect(watched(base, present)).toBe(true);
    expect(watched({ ...base, meshIp: undefined }, present)).toBe(true);
    expect(watched(base, undefined)).toBe(false);
    expect(watched(base, { presence: false })).toBe(false);
    expect(watched({ ...base, status: 'paused' }, present)).toBe(false);
    expect(watched({ ...base, status: 'waiting' }, present)).toBe(false);
  });

  it('takes an instance id and a token from a connection, nothing else', () => {
    expect(presenceAuth({ instanceId: 'inst-a', token: 't' })).toEqual({ instanceId: 'inst-a', token: 't' });
    expect(presenceAuth({ instanceId: 'inst-a', token: '' })).toBeUndefined();
    expect(presenceAuth({ instanceId: 3, token: 't' })).toBeUndefined();
    expect(presenceAuth(undefined)).toBeUndefined();
    expect(presenceAuth('inst-a')).toBeUndefined();
  });

  it('always tells a pool instance\'s owner and the operator; an own machine\'s owner unless switched off', () => {
    const pool = { ...base, pool: { ports: { backend: 1, edge: 2, registry: 3 }, startedAt: '', trialEndsAt: '' } } as InstanceRecord;
    expect(tellsOwner(pool, undefined)).toBe(true);
    expect(tellsOwner(pool, { notifyWhenUnreachable: false })).toBe(true);
    expect(tellsOperator(pool)).toBe(true);
    expect(tellsOwner(base, undefined)).toBe(true);
    expect(tellsOwner(base, { notifyWhenUnreachable: true })).toBe(true);
    expect(tellsOwner(base, { notifyWhenUnreachable: false })).toBe(false);
    expect(tellsOperator(base)).toBe(false);
  });

  it('writes the email from what root saw, never anything the person typed', () => {
    const down = instanceReachMail('down', base, { reachable: false, unreachableSince: at(0).toISOString(), lastSeenAt: at(-1).toISOString(), toldDown: true }, at(12));
    expect(down.subject).toBe('Your instance a (inst-a) has not answered for 12 minutes');
    expect(down.text).toMatch(/own machine: that machine may be off, asleep or offline/);
    expect(down.text).toMatch(/Settings → Notifications/);
    expect(instanceReachMail('back', base, { reachable: true }, at(13)).subject).toBe('Your instance a (inst-a) answers again');
    expect(instanceReachMail('down', base, { reachable: false, unreachableSince: at(0).toISOString() }, at(12), true).subject).toMatch(/^An instance/);
    expect(rootReachPush('down', 'https://app.example', { reachable: false, unreachableSince: at(0).toISOString() }, at(11)).body).toMatch(/for 11 minutes/);
    expect(rootReachPush('back', 'https://app.example', { reachable: true }, at(12)).title).toBe('Koala\'s root answers again');
  });
});
