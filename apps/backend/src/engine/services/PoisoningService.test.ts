import { describe, expect, it } from 'vitest';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { PoisoningService, PoisoningError } from './PoisoningService.js';
import { poisoningMemory as memory, poisoningServiceOn, poisoningSignal as signal } from '../testing/poisoning-service.js';

const service = (unindex: (ownerId: string, ids: string[]) => Promise<void> = async () => undefined) => poisoningServiceOn(memoryDatabase(), unindex);

describe('the findings a person sees and acts on', () => {
  it('a finding whose match cannot be unsealed says so instead of showing nothing', async () => {
    const db = memoryDatabase();
    const poisoning = new PoisoningService({
      store: db.engine,
      memories: { list: async () => [], save: async () => undefined, unindex: async () => undefined },
      unseal: () => { throw new Error('no key v2:old in the keyring'); },
      log: () => undefined,
    });
    await db.engine.savePoisoningSignal(signal({}));
    const [listed] = await poisoning.list('owner');
    expect(listed).not.toHaveProperty('matched');
    expect(listed?.matchUnreadable).toBe('the match was sealed under a key this Koala no longer holds: no key v2:old in the keyring');
  });

  it('lists only the person\'s own, worst first, with what was matched unsealed for them', async () => {
    const { db, poisoning } = await service();
    await db.engine.savePoisoningSignal(signal({ id: 'low', kind: 'unvouched-host', severity: 'low', sealedMatch: undefined }));
    await db.engine.savePoisoningSignal(signal({ id: 'high' }));
    await db.engine.savePoisoningSignal(signal({ id: 'theirs', ownerId: 'someone-else' }));
    const listed = await poisoning.list('owner', { open: true });
    expect(listed.map((one) => one.id)).toEqual(['high', 'low']);
    expect(listed[0]).toMatchObject({ matched: 'the secret line', host: 'attacker.example' });
    expect(JSON.stringify(listed)).not.toContain('readsKey');
    expect((await poisoning.list('owner', { runIds: ['run-1'] })).length).toBe(2);
  });

  it('dismisses with a reason kept, and never another person\'s', async () => {
    const { db, poisoning } = await service();
    await db.engine.savePoisoningSignal(signal({}));
    expect(await poisoning.dismiss('owner', 's1', 'my own test')).toMatchObject({ state: 'dismissed', dismissedBecause: 'my own test' });
    expect(await poisoning.list('owner', { open: true })).toEqual([]);
    await expect(poisoning.dismiss('someone-else', 's1')).rejects.toBeInstanceOf(PoisoningError);
  });

  it('retires what the run family left, or everything learned from the host, and nothing else', async () => {
    const { db, poisoning } = await service();
    await db.engine.savePoisoningSignal(signal({}));
    await db.memory.saveMemory(memory('from-child', { provenance: { experimentId: 'child-1' } }));
    await db.memory.saveMemory(memory('from-host', { provenance: { experimentId: 'run-9', sources: { classes: ['web'], hosts: ['attacker.example'], runs: ['run-9'] } } }));
    await db.memory.saveMemory(memory('unrelated', { provenance: { experimentId: 'run-7' } }));
    expect((await poisoning.retire('owner', 's1', 'run')).retired).toBe(1);
    expect((await poisoning.retire('owner', 's1', 'source')).retired).toBe(1);
    const left = (await db.memory.getMemories('owner')).filter((item) => !item.invalidAt).map((item) => item.id);
    expect(left).toEqual(['unrelated']);
    expect((await db.memory.getMemories('owner')).find((item) => item.id === 'from-host')!.text).toMatch(/retired with everything learned from attacker\.example/);
  });

  it('takes what it retires out of the index first, so recall never finds it again', async () => {
    const unindexed: string[][] = [];
    const { db, poisoning } = await service(async (_ownerId, ids) => { unindexed.push(ids); });
    await db.engine.savePoisoningSignal(signal({}));
    await db.memory.saveMemory(memory('from-host', { provenance: { experimentId: 'run-9', sources: { classes: ['web'], hosts: ['attacker.example'], runs: ['run-9'] } } }));
    await poisoning.retire('owner', 's1', 'source');
    expect(unindexed).toEqual([['from-host']]);
  });

  it('retires nothing and leaves the finding open when the index will not let go, saying why', async () => {
    const { db, poisoning } = await service(async () => { throw new Error('Qdrant refused: HTTP 503 overloaded'); });
    await db.engine.savePoisoningSignal(signal({}));
    await db.memory.saveMemory(memory('from-host', { provenance: { experimentId: 'run-9', sources: { classes: ['web'], hosts: ['attacker.example'], runs: ['run-9'] } } }));
    await expect(poisoning.retire('owner', 's1', 'source')).rejects.toThrow('Qdrant refused: HTTP 503 overloaded');
    expect((await db.memory.getMemories('owner'))[0]!.invalidAt).toBeUndefined();
    expect((await poisoning.list('owner', { open: true })).map((one) => one.id)).toEqual(['s1']);
  });

  it('refuses to retire by source when the finding names no host', async () => {
    const { db, poisoning } = await service();
    await db.engine.savePoisoningSignal(signal({ id: 'noted', kind: 'memory-from-outside', severity: 'medium', host: undefined }));
    await expect(poisoning.retire('owner', 'noted', 'source')).rejects.toMatchObject({ status: 409 });
  });

  it('pushes and emails a serious finding once, and only marks a lesser one told', async () => {
    const { db, poisoning, push, mail } = await service();
    await db.engine.savePoisoningSignal(signal({ id: 'canary', kind: 'canary', severity: 'certain', conversationId: 'c9' }));
    await db.engine.savePoisoningSignal(signal({ id: 'low', kind: 'unvouched-host', severity: 'low' }));
    expect(await poisoning.tellNew()).toBe(1);
    expect(await poisoning.tellNew()).toBe(0);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('owner', expect.objectContaining({ title: 'Koala: A run copied its own canary out', path: '/chat/c9' }));
    expect(mail).toHaveBeenCalledWith('owner', expect.objectContaining({ subject: 'Koala: A run copied its own canary out' }));
    expect(JSON.stringify(mail.mock.calls)).not.toContain('the secret line');
  });

  it('tells what was found before it started at once, and each finding recorded after as it comes, never twice', async () => {
    const { db, poisoning, push } = await service();
    await db.engine.savePoisoningSignal(signal({ id: 'before', kind: 'canary', severity: 'certain' }));
    const following = await poisoning.follow();
    expect(push.mock.calls.map((call) => (call as unknown[])[1])).toEqual([expect.objectContaining({ tag: 'poisoning-before' })]);
    await db.engine.savePoisoningSignal(signal({ id: 'after', kind: 'canary', severity: 'certain' }));
    await expect.poll(() => push.mock.calls.length).toBe(2);
    expect((push.mock.calls[1] as unknown[])[1]).toEqual(expect.objectContaining({ tag: 'poisoning-after' }));
    await following.close();
  });
});
