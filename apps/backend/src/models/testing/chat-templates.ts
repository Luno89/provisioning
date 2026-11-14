import { readFileSync } from 'node:fs';

const MIRRORED: Readonly<Record<string, string>> = {
  'meta-llama/Llama-3.1-8B-Instruct': 'unsloth/Llama-3.1-8B-Instruct',
  'meta-llama/Llama-3.2-3B-Instruct': 'unsloth/Llama-3.2-3B-Instruct',
  'meta-llama/Llama-3.3-70B-Instruct': 'unsloth/Llama-3.3-70B-Instruct',
  'meta-llama/Llama-4-Scout-17B-16E-Instruct': 'unsloth/Llama-4-Scout-17B-16E-Instruct',
};

export function chatTemplateFixture(model: string): string {
  const file = (MIRRORED[model] ?? model).replace('/', '__');
  return readFileSync(new URL(`./chat-templates/${file}.jinja`, import.meta.url), 'utf8');
}
