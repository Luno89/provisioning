import { clampDualBoundary } from './dual-boundary.js';

export interface MaskToolCall {
  name: string;
  arguments?: string | Record<string, unknown> | undefined;
}

export interface MaskToolResult {
  content: string;
  ok?: boolean | undefined;
  name?: string | undefined;
}

export interface MaskOptions {
  maxChars?: number | undefined;
  elidePayloadAboveBytes?: number | undefined;
  preserveErrors?: boolean | undefined;
}

function parseArgs(raw: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Distills an older tool observation into a high-signal, compact receipt.
 *
 * Invariant Rules:
 * 1. Errors, non-zero exits, and failure states are NEVER hidden or dropped.
 * 2. File reads and writes are reduced to concise structural receipts.
 * 3. Search results retain match counts and target file paths.
 * 4. Verbose command outputs preserve command signature and tail exit summaries.
 */
export function maskToolObservation(
  call: MaskToolCall,
  result: MaskToolResult,
  options: MaskOptions = {},
): MaskToolResult {
  const maxChars = options.maxChars ?? 8000;
  const rawContent = result.content ?? '';

  // Invariant 1: If execution failed, do not mask it away into a generic receipt!
  // High-entropy failure information prevents the agent from repeating the same bug.
  const isFailure = result.ok === false
    || /\b(error|failed|exception|exit code [1-9]|traceback|crash)\b/i.test(rawContent.slice(0, 300))
    || /\b(error|failed|exception|exit code [1-9]|traceback|crash)\b/i.test(rawContent.slice(-400));

  if (isFailure && (options.preserveErrors ?? true)) {
    return {
      ...result,
      ok: false,
      content: clampDualBoundary(rawContent, {
        maxChars: Math.min(maxChars, 4000),
        headRatio: 0.25,
      }),
    };
  }

  // If already fits comfortably in a tiny scalar response (e.g. "ok", numbers), keep it
  if (rawContent.length <= 60 && !rawContent.includes('\n')) {
    return result;
  }

  const args = parseArgs(call.arguments);
  const toolName = (call.name || result.name || '').toLowerCase();

  // File Read Tools (read_file, view_file, cat)
  if (toolName.includes('read') || toolName.includes('view') || toolName === 'cat') {
    const path = String(args.path || args.AbsolutePath || args.target || args.file || 'the file');
    const lines = rawContent.split('\n').length;
    const bytes = rawContent.length;
    return {
      ...result,
      content: `[File read: "${path}" (${lines} lines, ${bytes.toLocaleString()} bytes) — content elided to save context. Re-read specific lines if needed]`,
    };
  }

  // File Write Tools (write_file, write_to_file, edit_file)
  if (toolName.includes('write') || toolName.includes('edit') || toolName.includes('replace')) {
    const path = String(args.path || args.TargetFile || args.target || args.file || 'the file');
    const bytes = typeof args.content === 'string' ? args.content.length : rawContent.length;
    return {
      ...result,
      content: `[File modified: "${path}" (${bytes.toLocaleString()} bytes written) — read file if you need to review current contents]`,
    };
  }

  // Search Tools (grep_search, find_by_name, search)
  if (toolName.includes('search') || toolName.includes('grep') || toolName.includes('find')) {
    const query = String(args.query || args.Query || args.pattern || '');
    const lines = rawContent.split('\n').filter(Boolean);
    const count = lines.length;
    return {
      ...result,
      content: `[Search for "${query}": ${count} matches found. Files identified: ${lines.slice(0, 5).join('; ')}${count > 5 ? ` and ${count - 5} more` : ''}]`,
    };
  }

  // Directory Listing (list_dir, ls)
  if (toolName.includes('list') || toolName === 'ls') {
    const dir = String(args.path || args.DirectoryPath || '.');
    const lines = rawContent.split('\n').filter(Boolean);
    return {
      ...result,
      content: `[Directory listed: "${dir}" (${lines.length} items found)]`,
    };
  }

  // Command Execution (run_command, exec, bash)
  if (toolName.includes('command') || toolName.includes('exec') || toolName.includes('bash') || toolName === 'shell') {
    const command = String(args.command || args.CommandLine || args.cmd || '');
    return {
      ...result,
      content: `[Command succeeded: "${command || toolName}"]\n` + clampDualBoundary(rawContent, {
        maxChars: Math.min(maxChars, 1200),
        headRatio: 0.3,
      }),
    };
  }

  // Generic Tool: Use dual-boundary clamping
  return {
    ...result,
    content: clampDualBoundary(rawContent, {
      maxChars,
      headRatio: 0.2,
    }),
  };
}
