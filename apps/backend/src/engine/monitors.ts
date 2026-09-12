import { ThoughtFeatureExtractor, predictFailure } from '../lib/thinking-classifier.js';
import { detectThoughtLoop, type Turn } from '../lib/thought-loop.js';
import type { ModelThinkingProfile } from '../lib/thinking-classifier.js';
import type { StreamEvent } from './stream.js';
import type { StreamSink } from './model-call.js';
import type { RunState, ToolOutcome } from './run.js';

export interface MonitorContext {
  state: RunState;
}

export interface Monitor {
  name: string;
  onThinking?(text: string, ctx: MonitorContext): string | undefined;
  onContent?(text: string, ctx: MonitorContext): string | undefined;
  onRoundEnd?(ctx: MonitorContext): string | undefined;
  onToolResult?(outcome: ToolOutcome, ctx: MonitorContext): string | undefined;
  detectors?(): Record<string, number | boolean>;
}

export interface MonitorSet {
  sink(ctx: MonitorContext): StreamSink;
  roundEnded(ctx: MonitorContext): string | undefined;
  toolResulted(outcome: ToolOutcome, ctx: MonitorContext): string | undefined;
  detectors(): Record<string, number | boolean>;
  publish(state: RunState): void;
}

export function createMonitorSet(monitors: Monitor[]): MonitorSet {
  const reasonFrom = (name: string, reason: string | undefined): string | undefined =>
    (reason ? `${reason} (${name})` : undefined);

  return {
    sink(ctx: MonitorContext): StreamSink {
      return (event: StreamEvent): string | undefined => {
        for (const monitor of monitors) {
          if (event.kind === 'thinking' && monitor.onThinking) {
            const reason = monitor.onThinking(event.text, ctx);
            if (reason) return reasonFrom(monitor.name, reason);
          }
          if (event.kind === 'content' && monitor.onContent) {
            const reason = monitor.onContent(event.text, ctx);
            if (reason) return reasonFrom(monitor.name, reason);
          }
        }
        return undefined;
      };
    },

    roundEnded(ctx: MonitorContext): string | undefined {
      for (const monitor of monitors) {
        const reason = monitor.onRoundEnd?.(ctx);
        if (reason) return reasonFrom(monitor.name, reason);
      }
      return undefined;
    },

    toolResulted(outcome: ToolOutcome, ctx: MonitorContext): string | undefined {
      for (const monitor of monitors) {
        const reason = monitor.onToolResult?.(outcome, ctx);
        if (reason) return reasonFrom(monitor.name, reason);
      }
      return undefined;
    },

    detectors(): Record<string, number | boolean> {
      const all: Record<string, number | boolean> = {};
      for (const monitor of monitors) Object.assign(all, monitor.detectors?.() ?? {});
      return all;
    },

    publish(state: RunState): void {
      Object.assign(state.detectors, this.detectors());
    },
  };
}

export interface OverthinkOptions {
  seed?: string | undefined;
  profile?: ModelThinkingProfile | undefined;
  sensitivity?: 'low' | 'medium' | 'high' | undefined;
  failureThreshold?: number | undefined;
  ngramRepeatCap?: number | undefined;
}

export function overthinkMonitor(options: OverthinkOptions = {}): Monitor {
  const extractor = new ThoughtFeatureExtractor(options.seed ?? '');
  let warned = false;
  let pFailure = 0;

  return {
    name: 'overthinking',

    onThinking(text: string): string | undefined {
      extractor.pushReasoning(text);
      const prediction = predictFailure(
        extractor.extract(),
        options.profile,
        options.sensitivity ?? 'medium',
        options.failureThreshold ?? 0.65,
        options.ngramRepeatCap ?? 5,
      );
      pFailure = prediction.pFailure;
      if (!prediction.shouldInterrupt || warned) return undefined;
      warned = true;
      return prediction.reason ?? 'Overthinking loop detected';
    },

    detectors(): Record<string, number | boolean> {
      return { overthinkRisk: pFailure, overthinking: warned };
    },
  };
}

export interface RepetitionOptions {
  minRounds?: number | undefined;
}

export function repetitionMonitor(options: RepetitionOptions = {}): Monitor {
  const turns: Turn[] = [];
  let looping = false;
  let occurrences = 0;

  return {
    name: 'repetition',

    onRoundEnd(ctx: MonitorContext): string | undefined {
      const { reply } = ctx.state;
      turns.push({
        thought: reply.thinking,
        action: reply.toolCalls.map((call) => `${call.name}:${call.arguments}`).join(' ') || reply.content,
      });

      if (turns.length < (options.minRounds ?? 4)) return undefined;

      const verdict = detectThoughtLoop(turns);
      occurrences = verdict.occurrences;
      if (!verdict.looping || looping) return undefined;
      looping = true;
      return verdict.reason || 'going in circles';
    },

    detectors(): Record<string, number | boolean> {
      return { circling: looping, repeatedTurns: occurrences };
    },
  };
}

export interface StallOptions {
  maxSilentRounds?: number | undefined;
}

export function stallMonitor(options: StallOptions = {}): Monitor {
  const limit = options.maxSilentRounds ?? 2;
  let silentRounds = 0;

  return {
    name: 'stalled',

    onRoundEnd(ctx: MonitorContext): string | undefined {
      const { reply } = ctx.state;
      const saidSomething = reply.content.trim().length > 0;
      const didSomething = reply.toolCalls.length > 0;

      if (saidSomething || didSomething) {
        silentRounds = 0;
        return undefined;
      }

      silentRounds += 1;
      if (silentRounds < limit) return undefined;
      return `produced nothing for ${silentRounds} rounds in a row`;
    },

    detectors(): Record<string, number | boolean> {
      return { silentRounds, stalled: silentRounds >= limit };
    },
  };
}

export interface ToolFailureOptions {
  maxConsecutiveFailures?: number | undefined;
}

export function toolFailureMonitor(options: ToolFailureOptions = {}): Monitor {
  const limit = options.maxConsecutiveFailures ?? 3;
  let consecutive = 0;

  return {
    name: 'tool-failures',

    onToolResult(outcome: ToolOutcome): string | undefined {
      if (outcome.ok) {
        consecutive = 0;
        return undefined;
      }
      consecutive += 1;
      if (consecutive < limit) return undefined;
      return `${consecutive} tool calls failed in a row`;
    },

    detectors(): Record<string, number | boolean> {
      return { consecutiveToolFailures: consecutive };
    },
  };
}
