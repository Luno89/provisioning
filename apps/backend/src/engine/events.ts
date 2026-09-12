export type RunOutcome = 'ok' | 'failed' | 'exhausted' | 'refused' | 'interrupted';

export interface EventBase {
  runId: string;
  at: string;
}

export type EngineEvent =
  | (EventBase & { type: 'run.started'; agentId: string; loopId: string; parentRunId?: string })
  | (EventBase & { type: 'run.finished'; outcome: RunOutcome; reason?: string })
  | (EventBase & { type: 'node.entered'; nodeId: string })
  | (EventBase & { type: 'node.exited'; nodeId: string; via?: string })
  | (EventBase & { type: 'model.requested'; nodeId: string; model?: string; toolNames: string[] })
  | (EventBase & { type: 'thinking'; nodeId: string; delta: string })
  | (EventBase & { type: 'content'; nodeId: string; delta: string })
  | (EventBase & { type: 'tool.called'; nodeId: string; callId: string; name: string; args: string })
  | (EventBase & { type: 'tool.result'; nodeId: string; callId: string; ok: boolean; digest: string })
  | (EventBase & { type: 'usage'; nodeId: string; usage: Record<string, unknown> })
  | (EventBase & { type: 'notice'; level: 'info' | 'warn'; message: string })
  | (EventBase & { type: 'interrupted'; reason: string });

export type EventSubscriber = (event: EngineEvent) => void;

export interface SubscribeOptions {
  replay?: boolean;
}

export interface EventBus {
  emit(event: EngineEvent): void;
  subscribe(subscriber: EventSubscriber, options?: SubscribeOptions): () => void;
  retained(): readonly EngineEvent[];
  subscriberCount(): number;
}

export interface EventBusOptions {
  retain?: number;
  onSubscriberError?: (err: unknown, event: EngineEvent) => void;
}

export const DEFAULT_RETAIN = 2000;

export function createEventBus(options: EventBusOptions = {}): EventBus {
  const retain = options.retain ?? DEFAULT_RETAIN;
  const subscribers = new Set<EventSubscriber>();
  const buffer: EngineEvent[] = [];

  const reportError = options.onSubscriberError
    ?? ((err: unknown) => {
      console.warn(`[engine] event subscriber threw: ${(err as Error)?.message ?? String(err)}`);
    });

  return {
    emit(event: EngineEvent): void {
      if (retain > 0) {
        buffer.push(event);
        if (buffer.length > retain) buffer.splice(0, buffer.length - retain);
      }
      for (const subscriber of [...subscribers]) {
        try {
          subscriber(event);
        } catch (err) {
          reportError(err, event);
        }
      }
    },

    subscribe(subscriber: EventSubscriber, opts: SubscribeOptions = {}): () => void {
      if (opts.replay) {
        for (const event of [...buffer]) {
          try {
            subscriber(event);
          } catch (err) {
            reportError(err, event);
          }
        }
      }
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },

    retained(): readonly EngineEvent[] {
      return buffer;
    },

    subscriberCount(): number {
      return subscribers.size;
    },
  };
}
