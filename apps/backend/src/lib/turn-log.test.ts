import { describe, it, expect } from 'vitest';
import type { EngineEvent } from '@koala/agent-engine';
import { coalesce, replyFromLog, type TurnLogEntry } from './turn-log.js';

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
