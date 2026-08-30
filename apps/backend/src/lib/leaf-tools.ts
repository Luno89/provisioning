import type { ToolEffect } from './action-gate.js';
import type { Leaf } from './leaves.js';

export const WEB_TOOL_NAMES = ['web_search', 'fetch_web_page'] as const;


export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export class ToolCallScanner {
  private byIndex = new Map<number, { id: string; name: string; args: string }>();
  private buffer = '';

  push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const calls = JSON.parse(payload)?.choices?.[0]?.delta?.tool_calls;
        if (!Array.isArray(calls)) continue;
        for (const call of calls) {
          const index = Number(call?.index ?? 0);
          const existing = this.byIndex.get(index) ?? { id: '', name: '', args: '' };
          this.byIndex.set(index, {
            id: call?.id || existing.id,
            name: call?.function?.name || existing.name,
            args: existing.args + (call?.function?.arguments ?? ''),
          });
        }
      } catch { /* ignored */ }
    }
  }

  result(): ToolCall[] {
    return [...this.byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => ({ id: c.id, name: c.name, arguments: c.args }))
      .filter((c) => c.name);
  }
}

export function summariseLeaf(leaf: Leaf): Record<string, unknown> {
  return {
    id: leaf.id,
    title: leaf.title,
    status: leaf.status,
    ...(leaf.parentLeafId ? { parentLeafId: leaf.parentLeafId } : {}),
    ...(leaf.projectId ? { projectId: leaf.projectId } : {}),
    ...(leaf.attempts?.length ? { failedAttempts: leaf.attempts.length } : {}),
  };
}

export function detailLeaf(leaf: Leaf, children: Leaf[]): Record<string, unknown> {
  return {
    ...summariseLeaf(leaf),
    ...(leaf.body ? { body: leaf.body } : {}),
    ...(children.length ? { subLeaves: children.map(summariseLeaf) } : {}),
    ...(leaf.attempts?.length
      ? { attempts: leaf.attempts.map((a) => ({ attempt: a.attempt + 1, error: a.error })) }
      : {}),
  };
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}


