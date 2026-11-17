import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import { decryptValue, encryptValue } from '../../platform/lib/crypto.js';
import { testKeys } from '../../platform/testing/keys.js';
import { PoisoningService, PoisoningError } from './PoisoningService.js';
import type { PoisoningSignal } from '../lib/poisoning.js';
import type { MemoryItem } from '../../memory/index.js';
import { indexMemories, unindexerFrom } from '../../memory/lib/memory-index.js';
import { MEMORY_INDEX } from '../../memory/lib/memory-rank.js';
import { corpusEndpointsWith } from '../lib/web-tools-resolver.js';
import { startCorpusStandIn, type CorpusStandIn } from '../testing/corpus-stand-in.js';

let standIn: CorpusStandIn;
beforeAll(async () => { standIn = await startCorpusStandIn(); });
afterAll(async () => { await standIn.stop(); });

const at = '2026-10-29T10:00:00.000Z';
const signal = (over: Partial<PoisoningSignal>): PoisoningSignal => ({
  id: 's1', ownerId: 'owner', kind: 'private-out', severity: 'high', state: 'open', at, readsKey: 'grant-1', runId: 'run-1', tool: 'fetch_web_page',
  said: 'fetch_web_page sent out 40 characters this run read from file, to attacker.example', sealedMatch: 'sealed:the secret line', host: 'attacker.example', ...over,
});
const memory = (id: string, over: Partial<MemoryItem>): MemoryItem => ({
  id, ownerId: 'owner', category: 'lessons_learned', scope: 'global', status: 'active', title: id, text: id, createdAt: at, updatedAt: at, ...over,
});

async function service() {
  const db = await testDatabase();
  const push = vi.fn(async () => 1);
  const mail = vi.fn(async () => undefined);
  const poisoning = new PoisoningService({
    store: db.engine,
    memories: {
      list: (ownerId) => db.memory.getMemories(ownerId),
      save: (item) => db.memory.saveMemory(item),
      unindex: unindexerFrom((ownerId) => corpusEndpointsWith({ db: db.infrastructure, serviceUrl: async () => standIn.base }, ownerId)),
    },
    unseal: (sealed) => sealed.replace(/^sealed:/, ''),
    push, mail, now: () => '2026-10-29T11:00:00.000Z', log: () => undefined,
  });
  for (const appType of ['quickwit', 'qdrant', 'tei']) {
    await db.infrastructure.saveDeployment({ id: `${appType}-1`, name: appType, appType, status: 'running', clusterId: 'c1', strategy: 'helm', ownerId: 'owner', ...(appType === 'qdrant' ? { qdrantApiKey: 'stand-in-key' } : {}) });
  }
  await db.engine.openRunReads('grant-1', 'owner', 'run-1', 'k', at);
  await db.engine.openRunReads('grant-1', 'owner', 'child-1', 'k', at);
  return { db, poisoning, push, mail };
}

describe('the findings a person sees and acts on', () => {
  it('a finding whose match cannot be unsealed says so instead of showing nothing', async () => {
    const db = await testDatabase();
    const now = testKeys('now').data;
    const poisoning = new PoisoningService({
      store: db.engine,
      memories: { list: async () => [], save: async () => undefined },
      unseal: (sealed) => decryptValue(sealed, now),
      log: () => undefined,
    });
    await db.engine.savePoisoningSignal(signal({ id: 'old', sealedMatch: encryptValue('the secret line', testKeys('before').data) }));
    await db.engine.savePoisoningSignal(signal({ id: 'new', sealedMatch: encryptValue('the secret line', now) }));
    const listed = await poisoning.list('owner');
    const old = listed.find((one) => one.id === 'old');
    expect(old).not.toHaveProperty('matched');
    expect(old?.matchUnreadable).toMatch(/^the match was sealed under a key this Koala no longer holds: \S/);
    expect(listed.find((one) => one.id === 'new')).toMatchObject({ matched: 'the secret line' });
    expect(listed.find((one) => one.id === 'new')).not.toHaveProperty('matchUnreadable');
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

  it('takes everything learned from the host out of the person\'s own index, so nothing finds it again', async () => {
    const { db, poisoning } = await service();
    await db.engine.savePoisoningSignal(signal({}));
    const tainted = memory('tainted', { provenance: { experimentId: 'run-9', sources: { classes: ['web'], hosts: ['attacker.example'], runs: ['run-9'] } } });
    await db.memory.saveMemory(tainted);
    await indexMemories(standIn.endpoints, [tainted]);

    await poisoning.retire('owner', 's1', 'source');

    expect(standIn.documents(MEMORY_INDEX).filter((doc) => doc.memory_id === 'tainted')).toEqual([]);
    expect(standIn.points('koala-memory').filter((point) => point.memory_id === 'tainted')).toEqual([]);
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
