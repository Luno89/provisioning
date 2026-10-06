import { describe, it, expect } from 'vitest';
import { childFromSteps, reduceUnifiedFrames, type ChatRenderState } from '../lib/chat-unified-reducer.js';

const empty: ChatRenderState = {
  live: '', liveThinking: '', tools: [],
};

describe('reduceUnifiedFrames — unified wire → render state', () => {
  it('accumulates content deltas into live text', () => {
    let s = reduceUnifiedFrames(empty, { type: 'content', delta: 'He' });
    s = reduceUnifiedFrames(s, { type: 'content', delta: 'llo' });
    expect(s.live).toBe('Hello');
  });

  it('accumulates thinking deltas into liveThinking', () => {
    let s = reduceUnifiedFrames(empty, { type: 'thinking', delta: 'let me' });
    s = reduceUnifiedFrames(s, { type: 'thinking', delta: ' check' });
    expect(s.liveThinking).toBe('let me check');
  });

  it('adds a tool pill as running on toolAnnounce', () => {
    const s = reduceUnifiedFrames(empty, {
      type: 'toolAnnounce',
      payload: { id: 'c1', name: 'get_logs', args: '{"pod":"p"}' },
    });
    expect(s.tools).toHaveLength(1);
    expect(s.tools[0]).toMatchObject({ id: 'c1', name: 'get_logs', running: true });
  });

  it('flips the pill to done with ok/digest on toolResult', () => {
    let s = reduceUnifiedFrames(empty, {
      type: 'toolAnnounce', payload: { id: 'c1', name: 'get_logs', args: '{}' },
    });
    s = reduceUnifiedFrames(s, {
      type: 'toolResult', payload: { id: 'c1', ok: true, digest: 'log lines...' },
    });
    expect(s.tools[0]).toMatchObject({ running: false, ok: true, digest: 'log lines...' });
  });

  it('keeps what a tool made on its pill, so the chat can link to it', () => {
    let s = reduceUnifiedFrames(empty, { type: 'toolAnnounce', payload: { id: 'c1', name: 'research', args: '{}' } });
    s = reduceUnifiedFrames(s, {
      type: 'toolResult',
      payload: { id: 'c1', ok: true, digest: 'done', artifacts: [{ kind: 'file', workspace: 'conversation-x', path: 'research/r1/findings.md' }] },
    });
    expect(s.tools[0]!.artifacts).toEqual([{ kind: 'file', workspace: 'conversation-x', path: 'research/r1/findings.md' }]);
  });
});
describe('a hand-off\'s run drawn inside its call', () => {
  const announce = (id: string, name: string) => ({ type: 'toolAnnounce', payload: { id, name, args: '{}' } }) as const;
  const at = (path: string[], frame: Parameters<typeof reduceUnifiedFrames>[1]) => ({ type: 'childFrame', payload: { path, frame } });

  it('shows the child\'s calls and writing under the call that started it, and finishes it without finishing the turn', () => {
    let s = reduceUnifiedFrames(empty, announce('c1', 'research'));
    s = reduceUnifiedFrames(s, { type: 'childStarted', payload: { path: ['c1'], runId: 'r-research-1', agentId: 'research' } });
    s = reduceUnifiedFrames(s, at(['c1'], announce('x1', 'search_web')));
    s = reduceUnifiedFrames(s, at(['c1'], { type: 'toolResult', payload: { id: 'x1', ok: true, digest: '3 results' } }));
    s = reduceUnifiedFrames(s, at(['c1'], { type: 'content', delta: 'Postgres listens on ' }));
    s = reduceUnifiedFrames(s, at(['c1'], { type: 'content', delta: '5432' }));

    expect(s.live).toBe('');
    expect(s.tools[0]).toMatchObject({ id: 'c1', running: true, child: { runId: 'r-research-1', agentId: 'research', running: true, live: 'Postgres listens on 5432', tools: [{ id: 'x1', name: 'search_web', running: false, ok: true, digest: '3 results' }] } });

    s = reduceUnifiedFrames(s, { type: 'childFinished', payload: { path: ['c1'], outcome: 'ok' } });
    expect(s.tools[0]!.child).toMatchObject({ running: false, outcome: 'ok' });
    expect(s.tools[0]!.running).toBe(true);
  });

  it('nests a run that a child hands work to in turn, under the child\'s own call', () => {
    let s = reduceUnifiedFrames(empty, announce('c1', 'planner'));
    s = reduceUnifiedFrames(s, { type: 'childStarted', payload: { path: ['c1'], runId: 'r-planner-1', agentId: 'planner' } });
    s = reduceUnifiedFrames(s, at(['c1'], announce('p1', 'research')));
    s = reduceUnifiedFrames(s, { type: 'childStarted', payload: { path: ['c1', 'p1'], runId: 'r-planner-1-research-1', agentId: 'research' } });
    s = reduceUnifiedFrames(s, { type: 'childFrame', payload: { path: ['c1', 'p1'], frame: announce('g1', 'fetch_web_page') } });

    expect(s.tools[0]!.child!.tools[0]!.child).toMatchObject({ agentId: 'research', tools: [{ id: 'g1', name: 'fetch_web_page', running: true }] });
  });

  it('keeps the child when its run starts before the call is announced', () => {
    let s = reduceUnifiedFrames(empty, { type: 'childStarted', payload: { path: ['c1'], runId: 'r-research-1', agentId: 'research' } });
    expect(s.tools).toEqual([{ id: 'c1', name: 'research', args: '', running: true, child: { runId: 'r-research-1', agentId: 'research', running: true, live: '', tools: [] } }]);

    s = reduceUnifiedFrames(s, announce('c1', 'research'));
    expect(s.tools).toHaveLength(1);
    expect(s.tools[0]).toMatchObject({ args: '{}', child: { runId: 'r-research-1' } });
  });

  it('settles the child to what was stored when the call\'s result carries its steps, the same view a reload shows', () => {
    const steps = { runId: 'r-research-1', agentId: 'research', outcome: 'ok', steps: [{ callId: 'x1', name: 'write_file', ok: true, digest: 'wrote findings.md', artifacts: [{ kind: 'file' as const, workspace: 'conversation-c1', path: 'research/r/findings.md' }] }] };
    let s = reduceUnifiedFrames(empty, announce('c1', 'research'));
    s = reduceUnifiedFrames(s, { type: 'childStarted', payload: { path: ['c1'], runId: 'r-research-1', agentId: 'research' } });
    s = reduceUnifiedFrames(s, at(['c1'], { type: 'content', delta: 'half a thought' }));
    s = reduceUnifiedFrames(s, { type: 'toolResult', payload: { id: 'c1', ok: true, digest: 'found it', child: steps } });

    expect(s.tools[0]!.child).toEqual(childFromSteps(steps));
    expect(s.tools[0]!.child).toMatchObject({ running: false, outcome: 'ok', live: '', tools: [{ id: 'x1', name: 'write_file', running: false, ok: true }] });
  });
});
