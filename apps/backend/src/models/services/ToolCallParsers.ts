import type { ModelsStore } from '../store.js';
import { modelIdProblem } from '../lib/chat-templates.js';
import {
  parserFor, parserProblem, TOOL_CALLING_FIELDS, type ParserPick, type ToolCallParser, type VllmToolCalling, type VllmToolCallingAsked,
} from '../lib/tool-call-parsers.js';
import type { ChatTemplates } from './ChatTemplates.js';

export interface ToolCallParsersDeps {
  store: Pick<ModelsStore, 'getToolCallParsers'>;
  templates: ChatTemplates;
  savedToken: (ownerId: string | undefined) => Promise<string | undefined>;
}

export class ToolCallParsers {
  constructor(private readonly deps: ToolCallParsersDeps) {}

  list(): Promise<ToolCallParser[]> {
    return this.deps.store.getToolCallParsers();
  }

  async pick(model: string, asking: { ownerId: string | undefined; token?: string | undefined }): Promise<ParserPick> {
    const problem = modelIdProblem(model);
    if (problem) return { problem };
    const token = asking.token?.trim() || await this.deps.savedToken(asking.ownerId);
    const chat = await this.deps.templates.read(model, token);
    if ('problem' in chat) return chat;
    return parserFor(await this.list(), chat, model);
  }

  async decide(app: VllmToolCallingAsked, { newApp, ownerId }: { newApp: boolean; ownerId: string | undefined }): Promise<VllmToolCalling> {
    const enabled = app.vllmToolCallingEnabled ?? newApp;
    if (!enabled) return { vllmToolCallingEnabled: false };
    const picked = app.vllmToolCallParser || undefined;
    if (picked !== undefined) {
      const problem = parserProblem(await this.list(), picked);
      return problem ? { problem } : { vllmToolCallingEnabled: true, vllmToolCallParser: picked };
    }
    const chosen = await this.pick(app.vllmModel ?? '', { ownerId, token: app.vllmHfToken });
    return 'problem' in chosen ? chosen : { vllmToolCallingEnabled: true, vllmToolCallParser: chosen.parser };
  }

  async change(current: VllmToolCallingAsked & { appType?: string | undefined }, patch: VllmToolCallingAsked, { ownerId }: { ownerId: string | undefined }): Promise<VllmToolCalling | undefined> {
    if (current.appType !== 'vllm' || !TOOL_CALLING_FIELDS.some((field) => field in patch)) return undefined;
    return this.decide({ ...current, ...patch }, { newApp: false, ownerId });
  }
}
