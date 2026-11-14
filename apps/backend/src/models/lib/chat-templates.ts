import { isRecord } from '../../platform/lib/json-shapes.js';

export const CHAT_TEMPLATE_FILES = ['chat_template.jinja', 'tokenizer_config.json', 'chat_template.json'] as const;

export type ChatTemplateFile = typeof CHAT_TEMPLATE_FILES[number];

export type ChatTemplateIn = { template: string } | { none: true } | { unreadable: string };

const PREFERRED = ['tool_use', 'default'];

function fromField(file: ChatTemplateFile, field: unknown): ChatTemplateIn {
  if (field === undefined || field === null || field === '') return { none: true };
  if (typeof field === 'string') return field.trim() ? { template: field } : { none: true };
  if (Array.isArray(field)) {
    const named = field.filter(isRecord).filter((entry) => typeof entry.name === 'string' && typeof entry.template === 'string');
    for (const name of PREFERRED) {
      const found = named.find((entry) => entry.name === name);
      if (found) return { template: String(found.template) };
    }
    return { unreadable: `${file} names chat templates (${named.map((entry) => String(entry.name)).join(', ')}), none of them tool_use or default` };
  }
  return { unreadable: `${file}'s chat_template is neither text nor a list of named templates` };
}

export function chatTemplateIn(file: ChatTemplateFile, body: string): ChatTemplateIn {
  if (file === 'chat_template.jinja') return body.trim() ? { template: body } : { none: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { unreadable: `${file} is not JSON` };
  }
  return fromField(file, isRecord(parsed) ? parsed.chat_template : undefined);
}

const PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function modelIdProblem(model: string): string | undefined {
  if (!model.trim()) return 'Say which model vLLM serves';
  const parts = model.split('/');
  const fits = parts.length === 2 && parts.every((part) => PART.test(part) && !part.includes('..'));
  return fits ? undefined : `${model} is not a Hugging Face model: name it as owner/model`;
}
