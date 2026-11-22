import { describe, expect, it } from 'vitest';
import type { LocalAgentDeviceMetadata } from '../../platform/index.js';
import type { InstanceRecord } from '../../instances/index.js';
import { followingEnded, installFollowing, MACHINE_GONE } from './koala-install-following.js';

const JOINED = '2026-11-18T10:00:00.000Z';
const BEFORE = '2026-11-18T09:00:00.000Z';
const AFTER = '2026-11-18T10:05:00.000Z';
const desk: LocalAgentDeviceMetadata = { id: 'desk', ownerId: 'bo', name: 'desk', rootDir: '/home/bo/koala', createdAt: BEFORE, joinedAt: JOINED };
type Install = NonNullable<InstanceRecord['install']>;
const instance = (install: Partial<Install> & Pick<Install, 'state' | 'at'>, more: Partial<InstanceRecord> = {}): InstanceRecord => ({
  id: 'inst-bo', ownerId: 'bo', url: '', createdAt: BEFORE, updatedAt: install.at, machineId: 'desk',
  install: { id: 'install-1', machineId: 'desk', ...install },
  ...more,
});

describe('which install a joining machine follows', () => {
  it('follows the install running on the machine, as My Machines shows it', () => {
    const running = instance({ state: 'installing', stage: 'chart', title: 'Installing Koala\'s chart', line: 'waiting for deployment/koala', at: AFTER });
    expect(installFollowing(desk, [running])).toEqual({ kind: 'followed', followed: { install: { id: 'install-1', machineId: 'desk', state: 'installing', stage: 'chart', title: 'Installing Koala\'s chart', line: 'waiting for deployment/koala', at: AFTER } } });
  });

  it('waits while root has yet to start putting Koala on the machine it was asked for', () => {
    expect(installFollowing({ ...desk, koalaWanted: { name: 'bobby' } }, [])).toEqual({ kind: 'waiting' });
    expect(installFollowing({ ...desk, koalaWanted: { name: 'bobby' } }, [instance({ state: 'ready', at: BEFORE }, { url: 'https://old.koala.app' })])).toEqual({ kind: 'waiting' });
  });

  it('says where Koala answers once the install since the join is ready, and why once it failed', () => {
    expect(installFollowing(desk, [instance({ state: 'ready', at: AFTER }, { url: 'https://bobby.koala.app' })])).toEqual({ kind: 'followed', followed: { install: { id: 'install-1', machineId: 'desk', state: 'ready', at: AFTER }, url: 'https://bobby.koala.app' } });
    expect(installFollowing(desk, [instance({ state: 'failed', stage: 'chart', title: 'Installing Koala\'s chart', why: 'the image could not be pulled', at: AFTER })])).toEqual({ kind: 'followed', followed: { install: { id: 'install-1', machineId: 'desk', state: 'failed', stage: 'chart', title: 'Installing Koala\'s chart', why: 'the image could not be pulled', at: AFTER } } });
  });

  it('says why root would not put Koala on the machine since the join', () => {
    expect(installFollowing({ ...desk, koalaRefused: { reason: 'your Koala is on laptop; moving it is a step of its own', at: AFTER } }, [])).toEqual({ kind: 'stopped', why: 'your Koala is on laptop; moving it is a step of its own' });
  });

  it('has nothing to follow when the join asked for no Koala, whatever ended before it', () => {
    expect(installFollowing(desk, [])).toEqual({ kind: 'none' });
    expect(installFollowing(desk, [instance({ state: 'ready', at: BEFORE }, { url: 'https://old.koala.app' })])).toEqual({ kind: 'none' });
    expect(installFollowing({ ...desk, koalaRefused: { reason: 'an old refusal', at: BEFORE } }, [])).toEqual({ kind: 'none' });
  });

  it('follows only installs on this machine', () => {
    expect(installFollowing(desk, [instance({ id: 'install-9', machineId: 'laptop', state: 'installing', at: AFTER })])).toEqual({ kind: 'none' });
  });

  it('stops when the machine is no longer on the account', () => {
    expect(installFollowing(undefined, [])).toEqual({ kind: 'stopped', why: MACHINE_GONE });
  });

  it('ends on a ready or failed install, a stop, or nothing to follow, and goes on while waiting or installing', () => {
    expect(followingEnded({ kind: 'waiting' })).toBe(false);
    expect(followingEnded({ kind: 'followed', followed: { install: { id: 'i', machineId: 'desk', state: 'installing', at: AFTER } } })).toBe(false);
    expect(followingEnded({ kind: 'followed', followed: { install: { id: 'i', machineId: 'desk', state: 'ready', at: AFTER }, url: 'https://x' } })).toBe(true);
    expect(followingEnded({ kind: 'followed', followed: { install: { id: 'i', machineId: 'desk', state: 'failed', at: AFTER } } })).toBe(true);
    expect(followingEnded({ kind: 'stopped', why: 'x' })).toBe(true);
    expect(followingEnded({ kind: 'none' })).toBe(true);
  });
});
