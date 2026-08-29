import { describe, it, expect } from 'vitest';
import { summariseDelivery, type DeliveryStage } from './branch-delivery.js';
import type { Branch, Leaf } from './leaves.js';

const branch = (over: Partial<Branch> = {}): Branch => ({
  id: 'b1', ownerId: 'u1', title: 'req', messages: [],
  createdAt: '', updatedAt: '', ...over,
});

const leaf = (over: Partial<Leaf>): Leaf => ({
  id: 'l1', branchId: 'b1', ownerId: 'u1', title: 't', column: 'sprouting',
  status: 'succeeded', createdAt: '', updatedAt: '', ...over,
} as Leaf);

const stage = (s: DeliveryStage[], key: string) => s.find((x) => x.key === key)!;

describe('where a request got to', () => {
  it('reports nothing accepted before any leaf exists', () => {
    const s = summariseDelivery(branch(), [], undefined);
    expect(stage(s, 'work').state).toBe('pending');
    expect(stage(s, 'built').state).toBe('pending');
  });

  it('ignores leaves that are only proposed', () => {
    const s = summariseDelivery(branch(), [leaf({ status: 'proposed' })], undefined);
    expect(stage(s, 'work').state).toBe('pending');
  });

  it('counts verified separately from succeeded', () => {
    const s = summariseDelivery(branch(), [leaf({ id: 'a', verified: true }), leaf({ id: 'b' })], undefined);
    expect(stage(s, 'work')).toMatchObject({ state: 'done', detail: '1 of 2 verified' });
  });

  it('shows work as failed when a leaf failed, even though the others succeeded', () => {
    const s = summariseDelivery(branch(), [leaf({ id: 'a' }), leaf({ id: 'b', status: 'failed' })], undefined);
    expect(stage(s, 'work').state).toBe('failed');
  });

  it('is active while a leaf is still running', () => {
    const s = summariseDelivery(branch(), [leaf({ id: 'a' }), leaf({ id: 'b', status: 'running' })], undefined);
    expect(stage(s, 'work')).toMatchObject({ state: 'active', detail: '1 of 2 finished' });
  });

  it('only calls the work landed once every succeeded leaf is merged', () => {
    const partly = summariseDelivery(branch(), [leaf({ id: 'a', merged: true }), leaf({ id: 'b' })], undefined);
    expect(stage(partly, 'landed')).toMatchObject({ state: 'active', detail: '1 of 2 merged' });
    const all = summariseDelivery(branch(), [leaf({ id: 'a', merged: true }), leaf({ id: 'b', merged: true })], undefined);
    expect(stage(all, 'landed').state).toBe('done');
  });

  it('treats a built-but-undeployed request as skipped, not broken', () => {
    const s = summariseDelivery(branch(), [leaf({})], { status: 'built', reason: '' });
    expect(stage(s, 'built').state).toBe('done');
    expect(stage(s, 'deployed').state).toBe('skipped');
  });

  it('separates a pod that will not run from a deploy that never landed', () => {
    const sick = summariseDelivery(branch(), [leaf({})], { status: 'unhealthy', reason: 'web: CrashLoopBackOff' });
    expect(stage(sick, 'deployed')).toMatchObject({ state: 'warn', detail: 'web: CrashLoopBackOff' });
    const broke = summariseDelivery(branch(), [leaf({})], { status: 'deploy-failed', reason: '' });
    expect(stage(broke, 'deployed').state).toBe('failed');
  });

  it('does not claim a deploy is pending when the build is what failed', () => {
    const s = summariseDelivery(branch(), [leaf({})], { status: 'build-failed', reason: 'tsc exploded' });
    expect(stage(s, 'built')).toMatchObject({ state: 'failed', detail: 'tsc exploded' });
    expect(stage(s, 'deployed').state).toBe('pending');
  });

  it('says so when no acceptance checks were declared', () => {
    expect(stage(summariseDelivery(branch(), [leaf({})], undefined), 'accepted'))
      .toMatchObject({ state: 'skipped', detail: 'no checks declared' });
  });

  it('distinguishes waiting, passed, failed and no-verdict', () => {
    const plan = [{ name: 'tests', command: 'npm test' }];
    expect(stage(summariseDelivery(branch({ acceptance: plan }), [], undefined), 'accepted').state).toBe('pending');
    expect(stage(summariseDelivery(branch({ acceptance: plan, acceptanceRunAt: 'now', acceptanceOutcome: 'passed' }), [], undefined), 'accepted').state).toBe('done');
    expect(stage(summariseDelivery(branch({ acceptance: plan, acceptanceRunAt: 'now', acceptanceOutcome: 'failed', acceptanceFailedCheck: 'tests' }), [], undefined), 'accepted'))
      .toMatchObject({ state: 'failed', detail: 'failed at "tests"' });
    expect(stage(summariseDelivery(branch({ acceptance: plan, acceptanceRunAt: 'now', acceptanceOutcome: 'unknown' }), [], undefined), 'accepted'))
      .toMatchObject({ state: 'warn', detail: 'ran without a verdict' });
  });

  it('does not blame an old branch for a verdict the schema never stored', () => {
    const s = summariseDelivery(branch({ acceptance: [{ name: 'tests', command: 'npm test' }], acceptanceRunAt: 'then' }), [], undefined);
    expect(stage(s, 'accepted')).toMatchObject({ state: 'warn', detail: 'verdict not recorded' });
  });

  it('gives a research request a shorter chain, not struck-through stages', () => {
    const s = summariseDelivery(branch(), [leaf({ verified: true, findings: 'an answer' })], undefined);
    expect(s.map((x) => x.key)).toEqual(['work', 'answered', 'accepted']);
    expect(stage(s, 'work')).toMatchObject({ state: 'done', detail: '1 of 1 verified' });
    expect(stage(s, 'answered')).toMatchObject({ state: 'done', detail: 'answer written' });
  });

  it('does not treat a leaf that wrote nothing as answer-shaped work', () => {
    const s = summariseDelivery(branch(), [leaf({})], undefined);
    expect(s.map((x) => x.key)).toEqual(['work', 'landed', 'built', 'deployed', 'accepted']);
  });

  it('brings the build chain back the moment a request also produces code', () => {
    const s = summariseDelivery(branch(), [leaf({ id: 'r', findings: 'x' }), leaf({ id: 'c' })], undefined);
    expect(s.map((x) => x.key)).toEqual(['work', 'landed', 'built', 'deployed', 'accepted']);
  });

  it('still tracks merges when a request mixes research with code', () => {
    const s = summariseDelivery(branch(), [leaf({ id: 'r', findings: 'x' }), leaf({ id: 'c' })], undefined);
    expect(stage(s, 'landed')).toMatchObject({ state: 'pending', detail: '0 of 1 merged' });
  });

  it('ignores leaves belonging to another branch', () => {
    const s = summariseDelivery(branch(), [leaf({ branchId: 'other', status: 'failed' })], undefined);
    expect(stage(s, 'work').state).toBe('pending');
  });
});
