import type { Response } from 'express';
import type { Database } from './db-interface.js';
import { openSse, sendFrame } from './sse.js';
import { ThoughtFeatureExtractor, predictFailure, updateModelProfile } from './thinking-classifier.js';
import type { StreamEvent, PostPass } from './round-loop.js';
import type { UnifiedFrame } from './chat-wire.js';

export function stripThinkTags(text: string): { clean: string; thinking: string } {
  const thinkMatch = text.match(/<think>([\s\S]*?)(?:<\/think>|$)/i);
  const thinkText = thinkMatch ? (thinkMatch[1]?.trim() ?? '') : '';
  const clean = text.includes('<think>')
    ? text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim() || text
    : text;
  return { clean, thinking: thinkText };
}

export function standardPostPasses(featureExtractor: ThoughtFeatureExtractor): PostPass[] {
  return [
    {
      id: 'length-continuation',
      when: (ctx) => ctx.finishReason === 'length',
      buildMessages: (ctx) => [
        ...ctx.originalMessages,
        { role: 'assistant', content: ctx.answer },
        { role: 'user', content: 'Continue your response from exactly where you left off.' },
      ],
    },
    {
      id: 'monologue-recovery',
      when: (ctx) => {
        const text = ctx.thinking || featureExtractor.getText();
        return !ctx.answer.trim() && Boolean(text) && text.length > 20;
      },
      buildMessages: (ctx) => {
        const text = ctx.thinking || featureExtractor.getText();
        return [
          ...ctx.originalMessages,
          { role: 'assistant', content: text },
          { role: 'user', content: 'Based on your thoughts above, now state your concise final answer directly to the user.' },
        ];
      },
    },
  ];
}

export function openTurnSse(res: Response, enabledNames: string[]): void {
  openSse(res);
  if (enabledNames.length > 0) {
    sendFrame(res, { type: 'enabled', payload: enabledNames });
  }
}

export interface OverthinkMonitor {
  featureExtractor: ThoughtFeatureExtractor;
  onStreamEvent: (ev: StreamEvent) => string | void;
  recordOutcome: (interrupted: boolean) => Promise<void>;
}

export async function createOverthinkMonitor(opts: {
  db: Database;
  overthinking?: { sensitivity?: 'low' | 'medium' | 'high'; ngramRepeatCap?: number; failureThreshold?: number } | undefined;
  targetModelId: string;
  seedMessage: string;
  res: Response;
}): Promise<OverthinkMonitor> {
  const globalProfile = await opts.db.getModelThinkingProfile?.(opts.targetModelId).catch(() => null) ?? undefined;
  const featureExtractor = new ThoughtFeatureExtractor(opts.seedMessage);
  let warned = false;

  const onStreamEvent = (ev: StreamEvent): string | void => {
    if (ev.kind === 'reasoning') featureExtractor.pushReasoning(ev.text);
    const features = featureExtractor.extract();
    const sensitivity = opts.overthinking?.sensitivity ?? 'medium';
    const threshold = opts.overthinking?.failureThreshold ?? 0.65;
    const repeatCap = opts.overthinking?.ngramRepeatCap ?? 5;
    const pred = predictFailure(features, globalProfile, sensitivity, threshold, repeatCap);
    if (pred.shouldInterrupt && !warned) {
      warned = true;
      sendFrame(opts.res, { type: 'overthinkWarning', payload: pred.reason ?? 'Overthinking loop detected' });
    }
  };

  opts.res.on('close', () => {
    if (opts.res.writableEnded || !warned) return;
    try {
      const updatedProfile = updateModelProfile(globalProfile, opts.targetModelId, featureExtractor.extract(), 'failure');
      opts.db.saveModelThinkingProfile?.(updatedProfile).catch(() => undefined);
    } catch { /* ignored */ }
  });

  const recordOutcome = async (interrupted: boolean) => {
    try {
      const finalFeatures = featureExtractor.extract();
      const updatedProfile = updateModelProfile(globalProfile, opts.targetModelId, finalFeatures, interrupted ? 'failure' : 'success');
      await opts.db.saveModelThinkingProfile?.(updatedProfile);
    } catch { /* ignored */ }
  };

  return { featureExtractor, onStreamEvent, recordOutcome };
}

export interface SalvagedToolCall {
  id: string;
  name: string;
  args: string;
  ok: boolean;
  digest: string;
}

export interface TurnAccumulator {
  onFrame: (frame: UnifiedFrame) => void;
  hasContent: () => boolean;
  toSalvagedFields: () => {
    content: string;
    reasoning?: string;
    enabled?: string[];
    toolCalls?: SalvagedToolCall[];
  };
}

export function createTurnAccumulator(initialEnabled: string[] = []): TurnAccumulator {
  const acc = {
    content: '',
    thinking: '',
    enabled: [...initialEnabled],
    tools: new Map<string, SalvagedToolCall>(),
  };

  const onFrame = (frame: UnifiedFrame) => {
    if (frame.type === 'content') acc.content += frame.delta;
    else if (frame.type === 'thinking') acc.thinking += frame.delta;
    else if (frame.type === 'enabled') acc.enabled.push(...frame.payload);
    else if (frame.type === 'toolAnnounce') {
      acc.tools.set(frame.payload.id, { id: frame.payload.id, name: frame.payload.name, args: frame.payload.args, ok: true, digest: '' });
    } else if (frame.type === 'toolResult') {
      const existing = acc.tools.get(frame.payload.id);
      if (existing) acc.tools.set(frame.payload.id, { ...existing, ok: frame.payload.ok, digest: frame.payload.digest ?? '' });
    }
  };

  const hasContent = () => Boolean(acc.content || acc.thinking || acc.tools.size > 0);

  const toSalvagedFields = () => ({
    content: acc.content,
    ...(acc.thinking ? { reasoning: acc.thinking } : {}),
    ...(acc.enabled.length ? { enabled: acc.enabled } : {}),
    ...(acc.tools.size ? { toolCalls: [...acc.tools.values()] } : {}),
  });

  return { onFrame, hasContent, toSalvagedFields };
}
