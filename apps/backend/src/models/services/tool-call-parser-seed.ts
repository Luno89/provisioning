import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ModelsStore } from '../store.js';
import { seedChanges, toolCallParsersFrom } from '../lib/tool-call-parsers.js';

export const TOOL_CALL_PARSERS_FILE = fileURLToPath(new URL('../../../assets/tool-call-parsers.json', import.meta.url));

export async function seedToolCallParsers(
  store: Pick<ModelsStore, 'getToolCallParsers' | 'saveToolCallParser' | 'deleteToolCallParser'>,
  file: string = TOOL_CALL_PARSERS_FILE,
): Promise<number> {
  const wanted = toolCallParsersFrom(JSON.parse(readFileSync(file, 'utf8')));
  const { save, remove } = seedChanges(await store.getToolCallParsers(), wanted);
  for (const row of save) await store.saveToolCallParser(row);
  for (const parser of remove) await store.deleteToolCallParser(parser);
  return save.length + remove.length;
}
