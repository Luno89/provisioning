import { describe, it, expect } from 'vitest';
import type { EngineEvent } from '@koala/agent-engine';
import { coalesce, replyFromLog, runsUnder, tracedSummary, unansweredAsks, type TurnLogEntry } from './turn-log.js';

const at = '2026-10-05T00:00:00.000Z';
const ev = (event: Record<string, unknown>): EngineEvent => ({ runId: 't1', at, ...event }) as unknown as EngineEvent;

describe('coalescing a turn\'s events', () => {
  it('joins text deltas of one run and node, and keeps everything else in order', () => {
    expect(coalesce([
      ev({ type: 'content', nodeId: 'turn', delta: 'Hel' }),
      ev({ type: 'content', nodeId: 'turn', delta: 'lo' }),
      ev({ type: 'thinking', nodeId: 'turn', delta: 'hm' }),
      ev({ type: 'content', nodeId: 'turn', delta: ' there' }),
      ev({ type: 'content', nodeId: 'turn', delta: ' child', runId: 't1-research-1' }),
      ev({ type: 'tool.called', nodeId: 'tools', callId: 'c1', name: 'research', args: '{}' }),
    ])).toEqual([
      ev({ type: 'content', nodeId: 'turn', delta: 'Hello' }),
      ev({ type: 'thinking', nodeId: 'turn', delta: 'hm' }),
      ev({ type: 'content', nodeId: 'turn', delta: ' there' }),
      ev({ type: 'content', nodeId: 'turn', delta: ' child', runId: 't1-research-1' }),
      ev({ type: 'tool.called', nodeId: 'tools', callId: 'c1', name: 'research', args: '{}' }),
    ]);
  });
});

describe('rebuilding a reply that was never saved', () => {
  it('keeps what the turn\'s own run said and called, in order, with each call\'s result', () => {
    const child = { runId: 't1-research-1', agentId: 'research', outcome: 'ok', steps: [] };
    const entries: TurnLogEntry[] = [
      { turnId: 't1', ownerId: 'u1', seq: 2, at, events: [
        ev({ type: 'tool.result', nodeId: 'tools', callId: 'c1', ok: true, digest: 'found it', child }),
        ev({ type: 'content', nodeId: 'turn', delta: 'Port 5432' }),
        ev({ type: 'tool.called', nodeId: 'tools', callId: 'c2', name: 'read_file', args: '{"path":"a"}' }),
      ] },
      { turnId: 't1', ownerId: 'u1', seq: 1, at, events: [
        ev({ type: 'thinking', nodeId: 'turn', delta: 'look it up' }),
        ev({ type: 'tool.called', nodeId: 'tools', callId: 'c1', name: 'research', args: '{}' }),
        ev({ type: 'content', nodeId: 'turn', delta: 'not mine', runId: 't1-research-1' }),
      ] },
    ];

    expect(replyFromLog(entries, 't1')).toEqual({
      content: 'Port 5432',
      reasoning: 'look it up',
      toolCalls: [
        { id: 'c1', name: 'research', args: '{}', ok: true, digest: 'found it', child },
        { id: 'c2', name: 'read_file', args: '{"path":"a"}', ok: false, digest: 'it did not finish — the run ended first' },
      ],
    });
  });
});

describe('what a turn log carries of a step\'s trace', () => {
  const trace = { sequence: 4, node: 'turn.call', kind: 'call-model', role: 'step', durationMs: 900, exit: 'answered', inputs: { messages: ['the whole conversation'] }, outputs: { reply: 'it' } };

  it('keeps what the step was and how it went, never its inputs and outputs, which the run\'s stored traces hold', () => {
    expect(tracedSummary(trace)).toEqual({ sequence: 4, node: 'turn.call', kind: 'call-model', role: 'step', durationMs: 900, exit: 'answered' });
    expect(tracedSummary({ ...trace, error: 'refused' })).toMatchObject({ error: 'refused' });
    expect(tracedSummary({ ...trace, kind: 'external-agent', outputs: { identity: { name: 'antigravity-acp', title: 'Antigravity' }, model: { id: 'g38f', name: 'Gemini 3.8 Flash' } } })).toMatchObject({ kind: 'external-agent', model: 'Antigravity · Gemini 3.8 Flash' });
    expect(tracedSummary({ ...trace, kind: 'choose-model', role: 'value', outputs: { binding: { label: 'Qwen3.8-27B', contextTokens: 32_000 } } })).toEqual({ sequence: 4, node: 'turn.call', kind: 'choose-model', role: 'value', durationMs: 900, exit: 'answered', model: 'Qwen3.8-27B' });
  });

  it('cuts traces written before that down when a story reads its runs', () => {
    const read = runsUnder([{ seq: 1, events: [
      { type: 'node.traced', runId: 'leaf', at: 't', nodeId: 'turn.call', trace },
      { type: 'node.traced', runId: 'other', at: 't', nodeId: 'turn.call', trace },
    ] as EngineEvent[] }], 'leaf');

    expect(read.entries.flatMap((entry) => entry.events)).toEqual([
      { type: 'node.traced', runId: 'leaf', at: 't', nodeId: 'turn.call', trace: tracedSummary(trace) },
    ]);
    expect(read.through).toBe(1);
  });
});

describe('calls a tree run is still asking about', () => {
  const marks = [
    { type: 'run.started', runId: 'tree', agentId: 'grove' },
    { type: 'run.started', runId: 'tree-leaf-1', parentRunId: 'tree', agentId: 'grove-leaf' },
    { type: 'run.started', runId: 'tree-leaf-1-executor-1', parentRunId: 'tree-leaf-1', agentId: 'executor' },
    { type: 'notice', runId: 'tree-leaf-1-executor-1', level: 'warn', callId: 'c1', tool: 'delete_project', message: 'executor wants to run delete_project on this run: {}' },
    { type: 'notice', runId: 'tree-leaf-1-executor-1', level: 'warn', callId: 'c2', message: 'executor wants to run run_command on Desk: {}' },
    { type: 'tool.result', runId: 'tree-leaf-1-executor-1', callId: 'c2' },
    { type: 'notice', runId: 'tree-leaf-1-executor-1', level: 'warn', message: 'Nothing landed this pass' },
    { type: 'run.started', runId: 'tree-planner-2', parentRunId: 'tree', agentId: 'planner' },
    { type: 'notice', runId: 'tree-planner-2', level: 'warn', callId: 'c3', message: 'planner wants to run run_command on Desk: {}' },
    { type: 'run.started', runId: 'tree-old', parentRunId: 'tree', agentId: 'executor' },
    { type: 'notice', runId: 'tree-old', level: 'warn', callId: 'c4', tool: 'run_command' },
    { type: 'run.finished', runId: 'tree-old' },
  ];

  it('names each unanswered call, the agent asking, and the story whose run it is under', () => {
    expect(unansweredAsks(marks, [{ id: 'l1', runId: 'tree-leaf-1' }, { id: 'l2' }])).toEqual([
      { runId: 'tree-leaf-1-executor-1', callId: 'c1', tool: 'delete_project', message: 'executor wants to run delete_project on this run: {}', agent: 'executor', leafId: 'l1' },
      { runId: 'tree-planner-2', callId: 'c3', tool: 'run_command', message: 'planner wants to run run_command on Desk: {}', agent: 'planner' },
    ]);
  });
});
