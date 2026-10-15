import { describe, it, expect } from 'vitest';
import { externalRunEvents, permissionChoice, type ExternalToolSeen } from './external-agent-events.js';

const fresh = (): ExternalToolSeen => ({ called: new Set(), settled: new Set() });

describe('an external agent\'s events, as a run logs them', () => {
  it('joins streamed text and thinking, and keeps the whole reply', () => {
    const { events, text } = externalRunEvents('antigravity', 'agent', [
      { type: 'thinking', delta: 'Reading ' }, { type: 'thinking', delta: 'the brief' },
      { type: 'text', delta: 'Built ' }, { type: 'text', delta: 'it.' },
    ], fresh());
    expect(events).toEqual([
      { type: 'thinking', nodeId: 'agent', delta: 'Reading the brief' },
      { type: 'content', nodeId: 'agent', delta: 'Built it.' },
    ]);
    expect(text).toBe('Built it.');
  });

  it('logs each tool call once when it is first seen and once when it settles, across segments', () => {
    const seen = fresh();
    const first = externalRunEvents('antigravity', 'agent', [
      { type: 'tool', tool: { callId: 't1', title: 'odoo-check delivery_labels addons', kind: 'execute', status: 'pending', input: { commandLine: 'odoo-check delivery_labels addons' } } },
      { type: 'tool', tool: { callId: 't1', title: 'odoo-check delivery_labels addons', kind: 'execute', status: 'in_progress' } },
    ], seen);
    expect(first.events).toEqual([{ type: 'tool.called', nodeId: 'agent', callId: 'ext-t1', name: 'antigravity.execute', args: 'odoo-check delivery_labels addons {"commandLine":"odoo-check delivery_labels addons"}' }]);
    const second = externalRunEvents('antigravity', 'agent', [
      { type: 'tool', tool: { callId: 't1', title: 'odoo-check delivery_labels addons', kind: 'execute', status: 'completed', output: 'PASSED' } },
      { type: 'tool', tool: { callId: 't1', title: 'odoo-check delivery_labels addons', kind: 'execute', status: 'completed', output: 'PASSED' } },
      { type: 'tool', tool: { callId: 't2', title: 'rm -rf /', kind: 'delete', status: 'failed' } },
    ], seen);
    expect(second.events).toEqual([
      { type: 'tool.result', nodeId: 'agent', callId: 'ext-t1', ok: true, digest: 'PASSED' },
      { type: 'tool.called', nodeId: 'agent', callId: 'ext-t2', name: 'antigravity.delete', args: 'rm -rf /' },
      { type: 'tool.result', nodeId: 'agent', callId: 'ext-t2', ok: false, digest: 'rm -rf / failed' },
    ]);
  });

  it('warns when the agent ran a command outside the run\'s folder', () => {
    expect(externalRunEvents('antigravity', 'agent', [{ type: 'stray', callId: 'pwd', title: 'pwd', workingDir: '/home/x/.gemini/antigravity-cli/skills', folder: '/home/x/shop' }], fresh()).events)
      .toEqual([{ type: 'notice', level: 'warn', nodeId: 'agent', message: 'antigravity ran `pwd` in /home/x/.gemini/antigravity-cli/skills, outside the run\'s folder /home/x/shop' }]);
  });

  it('shows the agent\'s plan as a notice', () => {
    expect(externalRunEvents('antigravity', 'agent', [{ type: 'plan', entries: [{ content: 'Write the report', status: 'in_progress' }] }], fresh()).events)
      .toEqual([{ type: 'notice', level: 'info', nodeId: 'agent', message: 'antigravity\'s plan:\n- [in_progress] Write the report' }]);
  });
});

describe('answering an external agent\'s permission request', () => {
  const ask = (kinds: ('allow_once' | 'allow_always' | 'reject_once' | 'reject_always')[]) => ({
    tool: { callId: 't', title: 'git push', kind: 'execute', status: 'pending' as const },
    options: kinds.map((kind, index) => ({ optionId: `o${index}`, name: kind, kind })),
  });

  it('allows once when allowed and rejects once when not, never choosing "always" when "once" is offered', () => {
    expect(permissionChoice(ask(['allow_always', 'allow_once', 'reject_once']), true)).toBe('o1');
    expect(permissionChoice(ask(['allow_always', 'allow_once', 'reject_once']), false)).toBe('o2');
  });

  it('falls back to the broader choice, or to cancelling when the agent offers no way to say no', () => {
    expect(permissionChoice(ask(['allow_always', 'reject_always']), true)).toBe('o0');
    expect(permissionChoice(ask(['allow_once']), false)).toBeUndefined();
  });
});
