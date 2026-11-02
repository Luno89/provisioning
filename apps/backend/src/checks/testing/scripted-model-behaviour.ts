import { beforeEach, describe, expect, it } from 'vitest';
import type { ModelEndpointMetadata } from '../../platform/index.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { encryptValue } from '../../platform/lib/crypto.js';
import type { CheckScript } from '../lib/check-script.js';
import { spaceUser } from '../lib/check-space.js';
import { ScriptedModelService } from '../services/ScriptedModelService.js';

const KEY = 'test-key' as never;
const TOKEN = 'a-long-secret-token';

const SCRIPT: CheckScript = {
  rules: [
    { when: { asked: 'weather' }, reply: { say: 'It is dry.' } },
    { when: { asked: 'tasks' }, reply: { say: 'Task: {{mentioned.task}}', call: [{ tool: 'start_task', arguments: { id: '{{world.taskId}}' } }] } },
  ],
};

let db: Database;
let service: ScriptedModelService;

const endpoint = (spaceId: string, token: string): ModelEndpointMetadata => ({
  id: `scripted-${spaceId}`, ownerId: spaceId, name: 'Scripted model', baseUrl: 'http://x/v1', model: 'scripted', apiKeyEnc: encryptValue(token, KEY), createdAt: 't',
} as ModelEndpointMetadata);

const ask = (text: string) => ({ messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: text }], tools: [{ function: { name: 'start_task' } }, { type: 'x' }] });

export function scriptedModelBehaviour(make: () => Promise<Database>): void {
  beforeEach(async () => {
    db = await make();
    service = new ScriptedModelService({ store: db, dataKey: KEY, now: () => '2026-10-03T12:00:00.000Z' });
    await db.accounts.saveUser({ ...spaceUser('space-1', { person: 'bo', checkRunId: 'c1', scenarioId: 's', script: SCRIPT }, 't'), space: { person: 'bo', checkRunId: 'c1', scenarioId: 's', models: 'scripted', script: SCRIPT, world: { taskId: 't-9' } } });
    await db.models.saveModelEndpoint(endpoint('space-1', TOKEN));
    await db.projects.saveTask({ id: 't-9', ownerId: 'space-1', title: 'Greet', doneMeans: 'x', dependsOn: [], status: 'accepted', runs: [], createdAt: 't', updatedAt: 't' });
  });

  describe('the model a scripted check talks to', () => {
    it('answers with the first rule that matches what it is asked, and records the request it saw', async () => {
      expect(await service.answer('space-1', TOKEN, ask('what is the weather'))).toEqual({ answer: { say: 'It is dry.', calls: [] } });
      expect(await service.requests('space-1')).toEqual([
        { ownerId: 'space-1', at: '2026-10-03T12:00:00.000Z', text: '[system] be brief\n[user] what is the weather', tools: ['start_task'], rule: 0 },
      ]);
    });

    it('fills the space\'s world and tasks into what it says and calls', async () => {
      const answered = await service.answer('space-1', TOKEN, ask('list my tasks, starting with t-9'));
      expect(answered).toMatchObject({ answer: { say: 'Task: t-9', calls: [{ name: 'start_task', arguments: { id: 't-9' } }] } });
      expect(await service.answer('space-1', TOKEN, ask('list my tasks'))).toEqual({ miss: expect.stringContaining('rule 2 matched, but') as unknown });
    });

    it('says what it could not answer, and records that too', async () => {
      const answered = await service.answer('space-1', TOKEN, ask('something else'));
      expect(answered).toEqual({ miss: expect.stringContaining('the script has no answer') as unknown });
      expect((await service.requests('space-1'))[0]!.miss).toContain('something else');
    });

    it('answers a request with no body or messages as one asking nothing', async () => {
      expect(await service.answer('space-1', TOKEN, undefined)).toMatchObject({ miss: expect.stringContaining('no tools') as unknown });
      expect(await service.answer('space-1', TOKEN, { messages: 'nope' })).toMatchObject({ miss: expect.any(String) as unknown });
    });

    it('refuses a space that has no script, and a key that is not the space\'s own', async () => {
      await db.accounts.saveUser(spaceUser('space-2', { person: 'bo', checkRunId: 'c1', scenarioId: 's' }, 't'));
      expect(await service.answer('space-2', TOKEN, ask('x'))).toEqual({ refused: 404, error: 'there is no scripted check here' });
      expect(await service.answer('nobody', TOKEN, ask('x'))).toEqual({ refused: 404, error: 'there is no scripted check here' });
      expect(await service.answer('space-1', 'a-wrong-token', ask('x'))).toEqual({ refused: 401, error: 'that is not this check\'s key' });
      expect(await service.answer('space-1', `${TOKEN}-longer`, ask('x'))).toEqual({ refused: 401, error: 'that is not this check\'s key' });
      expect(await service.requests('space-1')).toEqual([]);
    });

    it('refuses a space whose endpoint is gone or belongs to someone else', async () => {
      await db.models.deleteModelEndpoint('scripted-space-1');
      expect(await service.answer('space-1', TOKEN, ask('x'))).toMatchObject({ refused: 401 });
      await db.models.saveModelEndpoint({ ...endpoint('space-1', TOKEN), ownerId: 'someone-else' });
      expect(await service.answer('space-1', TOKEN, ask('x'))).toMatchObject({ refused: 401 });
    });

    it('knows a space only by its own key', async () => {
      expect(await service.knows('space-1', TOKEN)).toBe(true);
      expect(await service.knows('space-1', 'wrong')).toBe(false);
      expect(await service.knows('ghost', TOKEN)).toBe(false);
    });

    it('stamps requests with the time when it is not given a clock', async () => {
      const plain = new ScriptedModelService({ store: db, dataKey: KEY });
      await plain.answer('space-1', TOKEN, ask('weather'));
      expect((await plain.requests('space-1')).at(-1)!.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    });
  });
}
