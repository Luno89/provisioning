import { refuse, type ToolHandler, type ToolOutcome } from '@koala/engine-core';
import { HANDOVER_TOOL, REVOKED_BECAUSE, handoverPath, renderHandover, type Handover, type RevokedBecause } from '../../engine/lib/run-grants.js';

export interface HandoverToolDeps {
  keep(ownerId: string, runId: string, handover: Handover): Promise<void>;
  now?: (() => Date) | undefined;
}

const becauseOf = (value: unknown): RevokedBecause =>
  (typeof value === 'string' && (REVOKED_BECAUSE as readonly string[]).includes(value) ? value as RevokedBecause : 'signed-out-everywhere');

export function createHandoverTools(deps: HandoverToolDeps): Record<string, ToolHandler> {
  return {
    async [HANDOVER_TOOL]({ parsed, caller, driver }): Promise<ToolOutcome> {
      const note = typeof parsed.note === 'string' ? parsed.note.trim() : '';
      if (!note) return refuse('a handover needs its note: where the work got to and what to pick up next');
      if (!caller.ownerId || !caller.runId) return refuse('a handover belongs to a run, and this call names none');
      const at = (deps.now?.() ?? new Date()).toISOString();
      const document = renderHandover(note, becauseOf(parsed.because), at);
      const path = handoverPath(caller.runId);
      const written = driver ? await driver.writeFile(path, document).then(() => true, (err: Error) => err.message) : undefined;
      await deps.keep(caller.ownerId, caller.runId, { note, ...(written === true ? { path } : {}) });
      const where = written === true ? `kept with the run and written to ${path}` : typeof written === 'string' ? `kept with the run; writing ${path} failed: ${written}` : 'kept with the run';
      return {
        ok: true,
        digest: `handover ${where}`,
        content: `Your handover note is ${where}.`,
        ...(written === true ? { artifacts: [{ kind: 'file' as const, path }] } : {}),
      };
    },
  };
}
