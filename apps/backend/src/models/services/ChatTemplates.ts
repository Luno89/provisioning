import { CHAT_TEMPLATE_FILES, chatTemplateIn, modelIdProblem } from '../lib/chat-templates.js';
import type { ChatTemplate } from '../lib/tool-call-parsers.js';

export type ChatTemplateRead = ChatTemplate | { problem: string };

export interface ChatTemplates {
  read(model: string, token: string | undefined): Promise<ChatTemplateRead>;
}

export class ChatTemplateUnread extends Error {
  readonly status = 502;
}

const REFUSED = new Set([401, 403]);

export function chatTemplatesOverHttp(huggingFace: string): ChatTemplates {
  const base = huggingFace.replace(/\/+$/, '');
  return {
    async read(model, token) {
      const problem = modelIdProblem(model);
      if (problem) return { problem };
      const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
      for (const file of CHAT_TEMPLATE_FILES) {
        let answer: Response;
        try {
          answer = await fetch(`${base}/${model}/resolve/main/${file}`, { headers });
        } catch (err) {
          throw new ChatTemplateUnread(`Koala could not reach Hugging Face for ${model}'s chat template: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!answer.ok) await answer.body?.cancel();
        if (answer.status === 404) continue;
        if (REFUSED.has(answer.status)) {
          return { problem: `Hugging Face would not show ${model}'s chat template (${answer.status}): the model is gated or does not exist. Check its name, or give a Hugging Face token that may read it` };
        }
        if (!answer.ok) throw new ChatTemplateUnread(`Hugging Face did not answer for ${model}'s chat template: it answered ${answer.status}`);
        const found = chatTemplateIn(file, await answer.text());
        if ('unreadable' in found) return { problem: `${model}'s chat template cannot be read: ${found.unreadable}` };
        if ('template' in found) return found;
      }
      return { none: true };
    },
  };
}
