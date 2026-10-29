import { describe, expect, it, vi } from 'vitest';
import { createHandoverTools } from './handover-tools.js';
import { HANDOVER_TOOLS } from './handover-tools-catalogue.js';
import { HANDOVER_TOOL } from '../../engine/lib/run-grants.js';
import type { EnvironmentDriver } from '@koala/engine-core';

const caller = { ownerId: 'owner', runId: 'run-1', agentSlug: 'koala' };
const at = new Date('2026-10-29T10:00:00Z');

describe('leaving a handover note', () => {
  it('is declared once, taking only the note', () => {
    expect(HANDOVER_TOOLS.map((tool) => tool.name)).toEqual([HANDOVER_TOOL]);
    expect(HANDOVER_TOOLS[0]!.parameters).toMatchObject({ required: ['note'] });
  });

  it('keeps the note with the run and writes it into the workspace, marked as written after access was revoked', async () => {
    const keep = vi.fn(async () => undefined);
    const writeFile = vi.fn(async () => undefined);
    const handler = createHandoverTools({ keep, now: () => at })[HANDOVER_TOOL]!;
    const outcome = await handler({ parsed: { note: 'Fixed the parser; the tests still fail.', because: 'password-or-2fa' }, caller, driver: { writeFile } as unknown as EnvironmentDriver } as never);
    expect(outcome).toMatchObject({ ok: true, content: 'Your handover note is kept with the run and written to handover/run-1.md.', artifacts: [{ kind: 'file', path: 'handover/run-1.md' }] });
    expect(writeFile).toHaveBeenCalledWith('handover/run-1.md', expect.stringMatching(/^# Handover\n\nWritten after access was revoked: their password or two-factor sign-in changed \(2026-10-29T10:00:00.000Z\)\.[\s\S]*Fixed the parser; the tests still fail\.\n$/));
    expect(keep).toHaveBeenCalledWith('owner', 'run-1', { note: 'Fixed the parser; the tests still fail.', path: 'handover/run-1.md' });
  });

  it('keeps the note with the run alone when the run had no workspace, or the file could not be written', async () => {
    const keep = vi.fn(async () => undefined);
    const handler = createHandoverTools({ keep, now: () => at })[HANDOVER_TOOL]!;
    expect((await handler({ parsed: { note: 'Read three pages.' }, caller } as never)).content).toBe('Your handover note is kept with the run.');
    const failing = { writeFile: vi.fn(async () => { throw new Error('the pod is gone'); }) } as unknown as EnvironmentDriver;
    expect((await handler({ parsed: { note: 'Read three pages.' }, caller, driver: failing } as never)).content).toBe('Your handover note is kept with the run; writing handover/run-1.md failed: the pod is gone.');
    expect(keep).toHaveBeenNthCalledWith(1, 'owner', 'run-1', { note: 'Read three pages.' });
  });

  it('refuses an empty note', async () => {
    const keep = vi.fn(async () => undefined);
    const outcome = await createHandoverTools({ keep })[HANDOVER_TOOL]!({ parsed: { note: '  ' }, caller } as never);
    expect(outcome.ok).toBe(false);
    expect(keep).not.toHaveBeenCalled();
  });
});
