import { describe, it, expect } from 'vitest';
import { createVerdictTools, renderVerdict } from './verdict-tools.js';

const caller = { ownerId: 'u1', runId: 'run-j', agentSlug: 'judge' };

const driverWriting = (files: Record<string, string>) => ({ writeFile: async (path: string, content: string) => { files[path] = content; } }) as never;

const record = (parsed: Record<string, unknown>, over: { inConversationWorkspace?: boolean; driver?: never } = {}) =>
  createVerdictTools()['record_verdict']!({
    name: 'record_verdict',
    parsed,
    driver: over.driver,
    caller: { ...caller, ...(over.inConversationWorkspace ? { inConversationWorkspace: true } : {}) },
  });

describe('recording a verdict', () => {
  it('writes it down in the conversation\'s workspace and hands it back to link', async () => {
    const files: Record<string, string> = {};
    const outcome = await record({ verdict: 'Met', reasoning: 'ran test.sh and it printed ok', expected: 'test.sh passes', judged: ['test.sh'] }, { inConversationWorkspace: true, driver: driverWriting(files) });

    expect(outcome).toMatchObject({ ok: true, digest: 'verdict: met', artifacts: [{ kind: 'file', path: '/work/judge/run-j/verdict.md' }] });
    expect(files['/work/judge/run-j/verdict.md']).toBe(renderVerdict({ verdict: 'met', reasoning: 'ran test.sh and it printed ok', expected: 'test.sh passes', judged: ['test.sh'] }));
    expect(files['/work/judge/run-j/verdict.md']).toContain('# Verdict: met');
  });

  it('writes nothing anywhere else, and still takes the verdict', async () => {
    const files: Record<string, string> = {};
    const outcome = await record({ verdict: 'unproven', reasoning: 'no workspace to check' }, { driver: driverWriting(files) });

    expect(outcome).toMatchObject({ ok: true, digest: 'verdict: unproven' });
    expect(outcome.artifacts).toBeUndefined();
    expect(files).toEqual({});
  });

  it('refuses a verdict that is not one, or has no reasoning', async () => {
    expect(await record({ verdict: 'probably', reasoning: 'x' })).toMatchObject({ ok: false, digest: 'a verdict is one of met, not met, unproven' });
    expect(await record({ verdict: 'met' })).toMatchObject({ ok: false });
  });
});
