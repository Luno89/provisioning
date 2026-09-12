import { describe, it, expect } from 'vitest';
import {
  createMonitorSet,
  overthinkMonitor,
  repetitionMonitor,
  stallMonitor,
  toolFailureMonitor,
  type Monitor,
} from './monitors.js';
import { createRunState, type RunState } from './run.js';

const ctxWith = (over: Partial<RunState['reply']> = {}): { state: RunState } => {
  const state = createRunState(0);
  state.reply = { content: '', thinking: '', finishReason: 'stop', toolCalls: [], ...over };
  return { state };
};

describe('stallMonitor', () => {
  it('stays quiet while the model is producing something', () => {
    const monitor = stallMonitor({ maxSilentRounds: 2 });
    expect(monitor.onRoundEnd?.(ctxWith({ content: 'progress' }))).toBeUndefined();
    expect(monitor.onRoundEnd?.(ctxWith({ toolCalls: [{ id: '1', name: 'ls', arguments: '{}' }] }))).toBeUndefined();
  });

  it('fires once the model produces nothing for long enough', () => {
    const monitor = stallMonitor({ maxSilentRounds: 2 });
    expect(monitor.onRoundEnd?.(ctxWith())).toBeUndefined();
    expect(monitor.onRoundEnd?.(ctxWith())).toMatch(/nothing for 2 rounds/);
  });

  it('resets the count when the model speaks again', () => {
    const monitor = stallMonitor({ maxSilentRounds: 2 });
    monitor.onRoundEnd?.(ctxWith());
    monitor.onRoundEnd?.(ctxWith({ content: 'back' }));
    expect(monitor.onRoundEnd?.(ctxWith())).toBeUndefined();
    expect(monitor.detectors?.()).toMatchObject({ silentRounds: 1, stalled: false });
  });
});

describe('toolFailureMonitor', () => {
  const outcome = (ok: boolean) => ({ callId: 'c', name: 'run', ok, digest: '' });

  it('fires after enough consecutive failures', () => {
    const monitor = toolFailureMonitor({ maxConsecutiveFailures: 3 });
    expect(monitor.onToolResult?.(outcome(false), ctxWith())).toBeUndefined();
    expect(monitor.onToolResult?.(outcome(false), ctxWith())).toBeUndefined();
    expect(monitor.onToolResult?.(outcome(false), ctxWith())).toMatch(/3 tool calls failed/);
  });

  it('resets on any success', () => {
    const monitor = toolFailureMonitor({ maxConsecutiveFailures: 2 });
    monitor.onToolResult?.(outcome(false), ctxWith());
    monitor.onToolResult?.(outcome(true), ctxWith());
    expect(monitor.onToolResult?.(outcome(false), ctxWith())).toBeUndefined();
    expect(monitor.detectors?.()).toEqual({ consecutiveToolFailures: 1 });
  });
});

describe('repetitionMonitor', () => {
  it('fires when the model keeps doing the same thing', () => {
    const monitor = repetitionMonitor({ minRounds: 4 });
    const same = ctxWith({ thinking: 'I will read the config file to understand the database host setting' });

    const reasons = [1, 2, 3, 4, 5].map(() => monitor.onRoundEnd?.(same));
    expect(reasons.filter(Boolean).length).toBe(1);
    expect(monitor.detectors?.()).toMatchObject({ circling: true });
  });

  it('stays quiet when each round differs', () => {
    const monitor = repetitionMonitor({ minRounds: 4 });
    const reasons = ['read the config', 'patch the deployment', 'restart the pod', 'verify the logs', 'write the summary']
      .map((thinking) => monitor.onRoundEnd?.(ctxWith({ thinking })));

    expect(reasons.filter(Boolean)).toEqual([]);
    expect(monitor.detectors?.()).toMatchObject({ circling: false });
  });
});

describe('overthinkMonitor', () => {
  it('interrupts on a long repetitive reasoning loop, and only once', () => {
    const monitor = overthinkMonitor({ sensitivity: 'high' });
    const ctx = ctxWith();
    const loop = 'I should check the logs again and again. '.repeat(60);

    const first = monitor.onThinking?.(loop, ctx);
    const second = monitor.onThinking?.(loop, ctx);

    expect(first).toBeTruthy();
    expect(second).toBeUndefined();
    expect(monitor.detectors?.()).toMatchObject({ overthinking: true });
  });

  it('leaves short, varied reasoning alone', () => {
    const monitor = overthinkMonitor();
    expect(monitor.onThinking?.('brief and to the point', ctxWith())).toBeUndefined();
    expect(monitor.detectors?.()).toMatchObject({ overthinking: false });
  });
});

describe('createMonitorSet', () => {
  const noisy: Monitor = {
    name: 'noisy',
    onContent: () => 'said a forbidden thing',
    detectors: () => ({ noisy: true }),
  };

  it('turns monitors into a stream sink that reports the first interrupt', () => {
    const set = createMonitorSet([noisy]);
    const sink = set.sink(ctxWith());

    expect(sink({ kind: 'thinking', text: 'fine' })).toBeUndefined();
    expect(sink({ kind: 'content', text: 'trouble' })).toBe('said a forbidden thing (noisy)');
  });

  it('collects detectors from every monitor and publishes them into run state', () => {
    const set = createMonitorSet([noisy, stallMonitor()]);
    const state = createRunState(0);

    set.publish(state);

    expect(state.detectors).toMatchObject({ noisy: true, silentRounds: 0, stalled: false });
  });

  it('reports the round and tool hooks with the monitor name attached', () => {
    const set = createMonitorSet([stallMonitor({ maxSilentRounds: 1 }), toolFailureMonitor({ maxConsecutiveFailures: 1 })]);

    expect(set.roundEnded(ctxWith())).toMatch(/\(stalled\)$/);
    expect(set.toolResulted({ callId: 'c', name: 'run', ok: false, digest: '' }, ctxWith())).toMatch(/\(tool-failures\)$/);
  });

  it('is inert when there are no monitors', () => {
    const set = createMonitorSet([]);
    expect(set.sink(ctxWith())({ kind: 'content', text: 'anything' })).toBeUndefined();
    expect(set.roundEnded(ctxWith())).toBeUndefined();
    expect(set.detectors()).toEqual({});
  });
});
