import type { ExtendedCompactionConfig } from '../config.js';

export interface GenericMessage {
  role?: string | undefined;
  content?: unknown;
  toolCalls?: { id?: string | undefined; name?: string | undefined; args?: string | undefined; ok?: boolean | undefined; digest?: string | undefined }[] | undefined;
  tool_calls?: { id?: string | undefined; type?: string | undefined; function?: { name?: string | undefined; arguments?: string | undefined } | undefined }[] | undefined;
  toolCallId?: string | undefined;
  name?: string | undefined;
  ok?: boolean | undefined;
}

export interface ContinuityState {
  goal: string;
  cumulativeUserDirectives: string[];
  filesCreated: string[];
  filesModified: string[];
  environmentFacts: string[];
  negativeKnowledge: string[];
  recentDiscoveries: string[];
  openProposals: string[];
  acceptedProposals: string[];
}

function stringContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (content && typeof content === 'object') {
    try {
      return JSON.stringify(content);
    } catch {
      return '';
    }
  }
  return '';
}

function cleanOneLine(text: string, maxLen = 200): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

/**
 * Extracts a high-fidelity Continuity State Vector from a conversation history.
 *
 * Captures all user steering directives, modified files, environment facts,
 * and negative knowledge (errors and failed approaches) without loss.
 */
export function extractContinuityState(
  messages: readonly GenericMessage[],
  config: Pick<ExtendedCompactionConfig, 'goalChars' | 'maxDiscoveries' | 'discoveryChars'>,
): ContinuityState {
  let goal = '';
  const cumulativeUserDirectives: string[] = [];
  const filesCreated = new Set<string>();
  const filesModified = new Set<string>();
  const environmentFacts = new Set<string>();
  const negativeKnowledge: string[] = [];
  const discoveries: string[] = [];
  const openProposals: string[] = [];
  const acceptedProposals: string[] = [];

  let isFirstUser = true;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const role = (m.role || '').toLowerCase();
    const content = stringContent(m.content);

    // User Directives
    if (role === 'user' && content) {
      if (isFirstUser) {
        goal = cleanOneLine(content, config.goalChars);
        isFirstUser = false;
      } else {
        // Collect subsequent user instructions, corrections, or constraints
        const directive = cleanOneLine(content, 300);
        if (directive && !cumulativeUserDirectives.includes(directive)) {
          cumulativeUserDirectives.push(`Turn ${i + 1}: ${directive}`);
        }
      }
    }

    // Inspect Tool Calls (Assistant role)
    const calls = m.toolCalls ?? (m.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function?.name,
      args: tc.function?.arguments,
      ok: true,
      digest: '',
    })) ?? []);

    for (const call of calls) {
      const name = (call.name || '').toLowerCase();
      let argsObj: Record<string, unknown> = {};
      try {
        if (call.args) argsObj = typeof call.args === 'string' ? JSON.parse(call.args) : call.args;
      } catch { /* ignored */ }

      const targetPath = String(argsObj.path || argsObj.TargetFile || argsObj.file || '');
      if (targetPath) {
        if (name.includes('create') || name.includes('new')) {
          filesCreated.add(targetPath);
        } else if (name.includes('write') || name.includes('edit') || name.includes('replace')) {
          filesModified.add(targetPath);
        }
      }

      // Check proposals
      if (name.includes('propose')) {
        const title = String(argsObj.name || argsObj.title || argsObj.goal || 'proposal');
        if (call.ok) openProposals.push(cleanOneLine(title, 120));
      }

      // Record Negative Knowledge from failed tool calls
      if (call.ok === false) {
        const reason = call.digest || stringContent(call.args);
        const item = `Tool "${call.name}" failed: ${cleanOneLine(reason, 200)}`;
        if (!negativeKnowledge.includes(item)) negativeKnowledge.push(item);
      }
    }

    // Inspect Tool Results
    if (role === 'tool') {
      const isOk = m.ok !== false;
      const toolName = m.name || 'tool';

      if (!isOk || /\b(error|failed|exit code [1-9]|exception)\b/i.test(content.slice(0, 200))) {
        const errorSummary = `"${toolName}" encountered error: ${cleanOneLine(content, config.discoveryChars)}`;
        if (!negativeKnowledge.includes(errorSummary)) {
          negativeKnowledge.push(errorSummary);
        }
      } else {
        // Environment Facts extraction
        const portMatch = content.match(/\b(?:port|listening on|reachable at)\s*[:=]?\s*([0-9]{2,5}|http[^\s]+)/i);
        if (portMatch?.[1]) {
          environmentFacts.add(`Service endpoint: ${portMatch[1]}`);
        }
      }

      // Record in discoveries (most recent first)
      const discovery = `${toolName} → ${cleanOneLine(content, config.discoveryChars)}`;
      discoveries.push(discovery);
    }
  }

  return {
    goal: goal || '(no initial goal recorded)',
    cumulativeUserDirectives,
    filesCreated: Array.from(filesCreated),
    filesModified: Array.from(filesModified).filter((f) => !filesCreated.has(f)),
    environmentFacts: Array.from(environmentFacts),
    negativeKnowledge: negativeKnowledge.slice(-10), // keep up to 10 recent failure lessons
    recentDiscoveries: discoveries.slice(-config.maxDiscoveries).reverse(),
    openProposals: openProposals.slice(0, 10),
    acceptedProposals: acceptedProposals.slice(0, 10),
  };
}
