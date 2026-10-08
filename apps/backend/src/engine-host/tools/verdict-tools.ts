import path from 'path';
import { refuse, type ToolHandler, type ToolOutcome } from '@koala/engine-core';
import { VERDICTS } from './verdict-tools-catalogue.js';

export const verdictPath = (agentSlug: string, runId: string): string => path.posix.join('/work', agentSlug, runId, 'verdict.md');

export function renderVerdict(verdict: { verdict: string; reasoning: string; expected?: string | undefined; judged?: readonly string[] | undefined }): string {
  return [
    `# Verdict: ${verdict.verdict}`,
    '',
    ...(verdict.expected ? ['## Expected', '', verdict.expected.trim(), ''] : []),
    ...(verdict.judged?.length ? ['## Looked at', '', ...verdict.judged.map((judged) => `- ${judged}`), ''] : []),
    '## Why',
    '',
    verdict.reasoning.trim(),
    '',
  ].join('\n');
}

const textArg = (parsed: Record<string, unknown>, key: string): string | undefined => (typeof parsed[key] === 'string' && parsed[key].trim() ? parsed[key] : undefined);

export function createVerdictTools(): Record<string, ToolHandler> {
  return {
    async record_verdict({ parsed, caller, driver }): Promise<ToolOutcome> {
      const verdict = textArg(parsed, 'verdict')?.toLowerCase();
      if (!verdict || !(VERDICTS as readonly string[]).includes(verdict)) return refuse(`a verdict is one of ${VERDICTS.join(', ')}`);
      const reasoning = textArg(parsed, 'reasoning');
      if (!reasoning) return refuse('a verdict needs its reasoning: what you checked and what settled it');
      const expected = textArg(parsed, 'expected');
      const judged = Array.isArray(parsed.judged) ? parsed.judged.filter((entry): entry is string => typeof entry === 'string') : [];

      const document = caller.inConversationWorkspace && driver && caller.agentSlug && caller.runId ? verdictPath(caller.agentSlug, caller.runId) : undefined;
      const written = document
        ? await driver!.writeFile(document, renderVerdict({ verdict, reasoning, expected, judged })).then(() => true, (err: Error) => err.message)
        : undefined;
      const note = written === true ? ` Written to ${document}.` : typeof written === 'string' ? ` Writing it to ${document} failed: ${written}.` : '';

      return {
        ok: true,
        digest: `verdict: ${verdict}`,
        content: `Your verdict is recorded: ${verdict}.${note} Now answer with it in a sentence or two.`,
        ...(written === true ? { artifacts: [{ kind: 'file' as const, path: document! }] } : {}),
      };
    },
  };
}
