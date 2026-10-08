import { timingSafeEqual } from 'node:crypto';
import { decryptValue, type SecretKey } from '../lib/crypto.js';
import { answerFrom, type ScriptAnswer, type ScriptMessage, type ScriptRequest } from '../lib/check-script.js';
import { scriptedEndpointId } from '../lib/check-space.js';
import type { ScriptedRequestRecord } from '../lib/db-interface.js';
import type { ModelEndpointMetadata, UserMetadata } from '../lib/types.js';

export interface ScriptedModelStore {
  getUserById(id: string): Promise<UserMetadata | undefined>;
  getModelEndpoints(): Promise<ModelEndpointMetadata[]>;
  getTasks(ownerId?: string): Promise<{ id: string }[]>;
  getLeaves(): Promise<{ id: string; ownerId?: string | undefined }[]>;
  saveScriptedRequest(request: ScriptedRequestRecord): Promise<void>;
  getScriptedRequests(ownerId: string): Promise<ScriptedRequestRecord[]>;
}

export type ScriptedAnswer =
  | { refused: 401 | 404; error: string }
  | { miss: string }
  | { answer: ScriptAnswer };

const sameToken = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const textOf = (messages: readonly ScriptMessage[]): string =>
  messages.map((message) => `[${message.role}] ${message.content ?? ''}${(message.tool_calls ?? []).map((call) => ` ${call.function.name} ${call.function.arguments}`).join('')}`).join('\n');

export class ScriptedModelService {
  constructor(private readonly deps: { store: ScriptedModelStore; dataKey: SecretKey; now?: () => string }) {}

  private async authorised(spaceId: string, token: string): Promise<UserMetadata | { refused: 401 | 404; error: string }> {
    const space = await this.deps.store.getUserById(spaceId);
    if (!space?.space?.script) return { refused: 404, error: 'there is no scripted check here' };
    const endpoint = (await this.deps.store.getModelEndpoints()).find((entry) => entry.id === scriptedEndpointId(spaceId) && entry.ownerId === spaceId);
    const expected = endpoint?.apiKeyEnc ? decryptValue(endpoint.apiKeyEnc, this.deps.dataKey) : undefined;
    if (!expected || !sameToken(expected, token)) return { refused: 401, error: 'that is not this check\'s key' };
    return space;
  }

  async answer(spaceId: string, token: string, body: unknown): Promise<ScriptedAnswer> {
    const space = await this.authorised(spaceId, token);
    if ('refused' in space) return space;
    const parsed = (body ?? {}) as { messages?: ScriptMessage[]; tools?: { function?: { name?: string } }[] };
    const request: ScriptRequest = {
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      tools: (parsed.tools ?? []).map((tool) => tool.function?.name ?? '').filter(Boolean),
    };
    const [tasks, leaves] = await Promise.all([this.deps.store.getTasks(spaceId), this.deps.store.getLeaves()]);
    const outcome = answerFrom(space.space!.script!, request, {
      tasks: tasks.map((task) => task.id),
      leaves: leaves.filter((leaf) => leaf.ownerId === spaceId).map((leaf) => leaf.id),
      world: space.space!.world ?? {},
    });
    await this.deps.store.saveScriptedRequest({
      ownerId: spaceId,
      at: this.deps.now?.() ?? new Date().toISOString(),
      text: textOf(request.messages),
      tools: request.tools,
      ...('rule' in outcome ? { rule: outcome.rule } : { miss: outcome.miss }),
    });
    return 'miss' in outcome ? { miss: outcome.miss } : { answer: outcome.answer };
  }

  async knows(spaceId: string, token: string): Promise<boolean> {
    return !('refused' in (await this.authorised(spaceId, token)));
  }

  async requests(spaceId: string): Promise<ScriptedRequestRecord[]> {
    return this.deps.store.getScriptedRequests(spaceId);
  }
}
