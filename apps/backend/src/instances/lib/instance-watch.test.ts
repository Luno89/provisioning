import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UNREACHABLE_MINUTES, instanceReachMail, isDown, nextReach, probeUrl, rootReachPush, tellsOperator, tellsOwner, unreachableAfterMs, watched,
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

  it('reads the threshold from the environment, ten minutes by default', () => {
    expect(unreachableAfterMs({})).toBe(DEFAULT_UNREACHABLE_MINUTES * 60_000);
    expect(unreachableAfterMs({ WATCH_UNREACHABLE_MINUTES: '2' })).toBe(120_000);
    expect(unreachableAfterMs({ WATCH_UNREACHABLE_MINUTES: 'soon' })).toBe(TEN);
    expect(unreachableAfterMs({ WATCH_UNREACHABLE_MINUTES: '0' })).toBe(TEN);
  });
});

describe('which instances root watches and whom it tells', () => {
  const base: InstanceRecord = { id: 'inst-a', ownerId: 'o', url: 'https://a.example', createdAt: '', updatedAt: '', status: 'ready', meshIp: '100.64.0.9', name: 'a' };

  it('watches an instance in service with a mesh address, never a stopped or waiting one', () => {
    expect(watched(base)).toBe(true);
    expect(watched({ ...base, meshIp: undefined })).toBe(false);
    expect(watched({ ...base, status: 'paused' })).toBe(false);
    expect(watched({ ...base, status: 'waiting' })).toBe(false);
    expect(probeUrl('100.64.0.9')).toBe('http://100.64.0.9:30320/api/auth/sign-in');
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
