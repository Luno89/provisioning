
import type { ToolCall } from './leaf-tools.js';

export interface ContentDelta {
  content?: string;
  reasoning_content?: string;
  [key: string]: unknown;
}

export type UnifiedFrame =
  | { type: 'content'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'toolAnnounce'; payload: { id: string; name: string; args: string } }
  | { type: 'toolResult'; payload: { id: string; ok: boolean; digest?: string } }
  | { type: 'proposedTree'; payload: unknown }
  | { type: 'proposedSpec'; payload: unknown }
  | { type: 'proposedEscalation'; payload: unknown }
  | { type: 'proposedSecretRequest'; payload: unknown }
  | { type: 'enabled'; payload: string[] }
  | { type: 'plan'; payload: unknown }
  | { type: 'usage'; payload: unknown }
  | { type: 'interrupted'; payload: unknown };

export const UNIFIED_FRAME_TYPES = [
  'content', 'thinking', 'toolAnnounce', 'toolResult',
  'proposedTree', 'proposedSpec', 'proposedEscalation', 'proposedSecretRequest', 'enabled', 'plan', 'usage', 'interrupted',
] as const;

export function isUnifiedFrame(v: unknown): v is UnifiedFrame {
  return (
    typeof v === 'object' &&
    v !== null &&
    'type' in (v as any) &&
    (UNIFIED_FRAME_TYPES as readonly string[]).includes((v as any).type)
  );
}

export function toolResultFrame(
  id: string,
  name: string,
  ok: boolean,
  digest: string,
): UnifiedFrame {
  return { type: 'toolResult', payload: { id, ok, digest } };
}

export interface TurnFrames {
  content: ContentDelta[];
  thinking: string[];
  toolAnnounces: { id: string; name: string; args: string }[];
  toolResults: { id: string; ok: boolean; digest: string }[];
  proposedTrees: unknown[];
  proposedSpecs: unknown[];
  enabled: string[];
  plans: string[];
  usages: Record<string, unknown>[];
  interrupted?: string;
}
