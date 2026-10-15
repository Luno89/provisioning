import { describe, it, expect } from 'vitest';
import { AgentEvents, TOOL_OUTPUT_CHARS } from './acp-events.js';

describe('what an ACP agent says, as events a run can log', () => {
  it('passes text and thinking through, and drops empty chunks', () => {
    const events = new AgentEvents();
    expect(events.read({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } })).toEqual({ type: 'text', delta: 'Hi' });
    expect(events.read({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } })).toEqual({ type: 'thinking', delta: 'hmm' });
    expect(events.read({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } })).toBeUndefined();
    expect(events.read({ sessionUpdate: 'available_commands_update', availableCommands: [] })).toBeUndefined();
  });

  it('follows a tool call through its updates, keeping what an update leaves out', () => {
    const events = new AgentEvents();
    expect(events.read({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run odoo-check', kind: 'execute', status: 'pending', rawInput: { command: 'odoo-check x' } })).toEqual({
      type: 'tool', tool: { callId: 't1', title: 'Run odoo-check', kind: 'execute', status: 'pending', input: { command: 'odoo-check x' } },
    });
    expect(events.read({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'PASSED' } }, { type: 'diff', path: '/w/a.py', newText: 'x' }], locations: [{ path: '/w/a.py' }] })).toEqual({
      type: 'tool', tool: { callId: 't1', title: 'Run odoo-check', kind: 'execute', status: 'completed', input: { command: 'odoo-check x' }, output: 'PASSED\nedited /w/a.py', paths: ['/w/a.py'] },
    });
  });

  it('cuts long tool output, and reads raw output when there is no content', () => {
    const events = new AgentEvents();
    const long = events.read({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'cat', rawOutput: 'x'.repeat(TOOL_OUTPUT_CHARS + 10) });
    expect(long?.type === 'tool' && long.tool.output).toHaveLength(TOOL_OUTPUT_CHARS + 1);
    const raw = events.read({ sessionUpdate: 'tool_call_update', toolCallId: 't3', rawOutput: { exitCode: 0 } });
    expect(raw).toEqual({ type: 'tool', tool: { callId: 't3', title: 't3', kind: 'other', status: 'pending', output: '{"exitCode":0}' } });
  });

  it('reports the plan and a change of mode', () => {
    const events = new AgentEvents();
    expect(events.read({ sessionUpdate: 'plan', entries: [{ content: 'Write the report', priority: 'high', status: 'in_progress' }] })).toEqual({ type: 'plan', entries: [{ content: 'Write the report', status: 'in_progress' }] });
    expect(events.read({ sessionUpdate: 'current_mode_update', currentModeId: 'auto' })).toEqual({ type: 'mode', modeId: 'auto' });
  });
});
