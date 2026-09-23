import { createCompactionConfig, type ExtendedCompactionConfig } from '../config.js';
import { estimateMessageTokens } from '../tokens/token-estimator.js';
import { calculatePressure } from '../tokens/context-budget.js';
import { maskToolObservation } from '../observations/observation-masker.js';
import { extractContinuityState } from '../state/state-vector.js';
import { renderContinuityNotice } from '../state/state-renderer.js';
import type { ContextMessage, CompactionResult } from './compactor-types.js';

export interface CompactionOptions {
  windowTokens: number;
  marginTokens?: number | undefined;
  config?: Partial<ExtendedCompactionConfig> | undefined;
  now?: (() => string) | undefined;
}

/**
 * Applies smart observation masking to intermediate tool turns while keeping
 * head and recent tail whole.
 */
function applyObservationMasking<T extends ContextMessage>(
  messages: readonly T[],
  cfg: ExtendedCompactionConfig,
): T[] {
  const headCount = Math.min(cfg.preserveHeadTurns, Math.max(0, messages.length - 2));
  // Leave room for middle messages if possible; the active tail is at least the latest 2 messages
  const maxTail = Math.max(1, messages.length - headCount - 2);
  const tailCount = Math.min(cfg.liveTailTurns, Math.max(1, maxTail > 0 ? 2 : 1));

  const head = messages.slice(0, headCount);
  const middle = messages.slice(headCount, messages.length - tailCount);
  const tail = messages.slice(messages.length - tailCount);

  // Build index of tool calls across messages to link arguments to tool results
  const toolCallMap = new Map<string, { name: string; arguments?: string | Record<string, unknown> | undefined }>();
  const recentToolCalls: { name: string; arguments?: string | Record<string, unknown> | undefined }[] = [];

  for (const m of messages) {
    if (m.tool_calls && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const info = { name: tc.function?.name || '', arguments: tc.function?.arguments };
        if (tc.id) toolCallMap.set(tc.id, info);
        recentToolCalls.push(info);
      }
    }
    if (m.toolCalls && Array.isArray(m.toolCalls)) {
      for (const tc of m.toolCalls) {
        const info = { name: tc.name || '', arguments: tc.args };
        if (tc.id) toolCallMap.set(tc.id, info);
        recentToolCalls.push(info);
      }
    }
  }

  const maskedMiddle: T[] = middle.map((m) => {
    const role = (m.role || '').toLowerCase();

    // Mask tool results
    if (role === 'tool') {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      const callId = String(m.tool_call_id || m.toolCallId || '');
      const matchedCall = (callId && toolCallMap.get(callId))
        || recentToolCalls.find((c) => c.name === m.name)
        || { name: m.name || '' };

      const masked = maskToolObservation(
        matchedCall,
        { content, ok: m.ok !== false, name: m.name || matchedCall.name },
        { maxChars: cfg.maxOutputChars, elidePayloadAboveBytes: cfg.elidePayloadAboveBytes, preserveErrors: true },
      );
      return { ...m, content: masked.content };
    }

    // Elide write payloads in tool_calls for assistant
    if (m.tool_calls && Array.isArray(m.tool_calls)) {
      let changed = false;
      const nextCalls = m.tool_calls.map((c) => {
        const fnName = (c?.function?.name || '').toLowerCase();
        if ((fnName.includes('write') || fnName.includes('edit')) && typeof c.function?.arguments === 'string') {
          if (c.function.arguments.length > cfg.elidePayloadAboveBytes) {
            changed = true;
            let path = 'the file';
            try {
              const parsed = JSON.parse(c.function.arguments);
              if (parsed.path || parsed.TargetFile) path = parsed.path || parsed.TargetFile;
            } catch { /* ignored */ }
            return {
              ...c,
              function: {
                ...c.function,
                arguments: JSON.stringify({ path, content: `[${c.function.arguments.length} bytes already written — read file if needed]` }),
              },
            };
          }
        }
        return c;
      });
      if (changed) {
        return { ...m, tool_calls: nextCalls };
      }
    }

    // Drop historical reasoning traces older than reasoningKeptTurns
    if (m.reasoning) {
      const { reasoning: _dropped, ...rest } = m;
      return rest as unknown as T;
    }

    return m;
  });

  return [...head, ...maskedMiddle, ...tail];
}

/**
 * Collapses historical conversation turns into a structured Continuity State Frame,
 * preserving cumulative user directives and negative knowledge.
 */
function applyStateCompaction<T extends ContextMessage>(
  messages: readonly T[],
  cfg: ExtendedCompactionConfig,
  nowIso: string,
): { messages: T[]; state: ReturnType<typeof extractContinuityState> } {
  const headCount = Math.min(cfg.preserveHeadTurns, Math.max(0, messages.length - 2));
  const maxTail = Math.max(1, messages.length - headCount - 1);
  const tailCount = Math.min(cfg.liveTailTurns, maxTail);

  const head = messages.slice(0, headCount);
  let tail = messages.slice(-tailCount);

  // If tail begins with an orphaned tool result, adjust so it doesn't break chat invariants
  while (tail.length > 1 && tail[0]?.role === 'tool') {
    tail = tail.slice(1);
  }

  // Extract 5-part state vector from the entire history
  const state = extractContinuityState(messages, cfg);
  const noticeContent = renderContinuityNotice(state);

  const noticeMessage: ContextMessage = {
    role: 'assistant',
    content: noticeContent,
    at: nowIso,
    notice: true,
    handoff: true,
  };

  return {
    messages: [...head, noticeMessage as unknown as T, ...tail],
    state,
  };
}

/**
 * 4-Tier Progressive Compaction Pipeline.
 *
 * Tier 0: Normal (< softThreshold) - Passed through verbatim.
 * Tier 1: Soft Mask (softThreshold - hardThreshold) - Applies smart observation masking to historical tool outputs.
 * Tier 2: Hard Compact (hardThreshold - criticalThreshold) - Compiles Continuity State Frame and appends live working tail.
 * Tier 3: Critical Reset (>= criticalThreshold) - Compiles Continuity State Frame, flags for checkpoint commit.
 */
export function progressiveCompact<T extends ContextMessage>(
  messages: readonly T[],
  options: CompactionOptions,
): CompactionResult<T> {
  const cfg = createCompactionConfig(options.config);
  const now = options.now?.() ?? new Date().toISOString();
  const originalTokens = estimateMessageTokens(messages);
  const initialPressure = calculatePressure(originalTokens, {
    windowTokens: options.windowTokens,
    marginTokens: options.marginTokens,
  });

  // If well within budget, return untouched
  if (initialPressure < cfg.softThreshold) {
    return {
      messages: [...messages],
      phase: 'normal',
      pressure: initialPressure,
      originalTokens,
      compactedTokens: originalTokens,
    };
  }

  // Tier 1: Try smart observation masking first (zero loss of user/assistant turns)
  const masked = applyObservationMasking(messages, cfg);
  const maskedTokens = estimateMessageTokens(masked);
  const maskedPressure = calculatePressure(maskedTokens, {
    windowTokens: options.windowTokens,
    marginTokens: options.marginTokens,
  });

  // If observation masking successfully brought pressure under hardThreshold, return masked!
  if (maskedPressure < cfg.hardThreshold) {
    return {
      messages: masked,
      phase: 'soft_mask',
      pressure: maskedPressure,
      originalTokens,
      compactedTokens: maskedTokens,
    };
  }

  // Tier 2: Observation masking was not enough; perform Structured State Compaction
  const { messages: compacted, state } = applyStateCompaction(messages, cfg, now);
  const compactedTokens = estimateMessageTokens(compacted);
  const compactedPressure = calculatePressure(compactedTokens, {
    windowTokens: options.windowTokens,
    marginTokens: options.marginTokens,
  });

  const finalPhase = compactedPressure >= cfg.criticalThreshold ? 'critical_reset' : 'hard_compact';

  return {
    messages: compacted,
    phase: finalPhase,
    pressure: compactedPressure,
    originalTokens,
    compactedTokens,
    state,
  };
}
