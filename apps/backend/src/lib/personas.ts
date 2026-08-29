import type { Overrides, Persona } from '@koala/harness-types';
import type { HarnessProfile } from './harness-profile.js';
import { RESET_TO_DEFAULT } from './harness-profile.js';

export type { Persona };

export type OverrideSource = 'profile' | 'pack' | 'request';

export interface ResolvedConfig {
  overrides: Overrides;
  from: Record<OverrideSource, string[]>;
  systemPrompt?: string;
}

export function resolveConfig(
  profile: HarnessProfile | null,
  pack: { overrides?: Overrides } | null,
  request: Overrides = {},
  persona?: { systemPrompt?: string } | null,
): ResolvedConfig {
  const layers: [OverrideSource, Overrides][] = [
    ['profile', profile?.overrides ?? {}],
    ['pack', pack?.overrides ?? {}],
    ['request', request],
  ];

  const overrides: Overrides = {};
  const owner = new Map<string, OverrideSource>();

  for (const [source, bag] of layers) {
    for (const [key, value] of Object.entries(bag)) {
      if (value === RESET_TO_DEFAULT) {
        overrides[key] = undefined;
        delete overrides[key];
        owner.delete(key);
        continue;
      }
      overrides[key] = value;
      owner.set(key, source);
    }
  }

  const from: Record<OverrideSource, string[]> = { profile: [], pack: [], request: [] };
  for (const [key, source] of owner) from[source].push(key);
  for (const source of Object.keys(from) as OverrideSource[]) from[source].sort();

  const prompt = persona?.systemPrompt?.trim()
    || (typeof overrides.systemPrompt === 'string' ? overrides.systemPrompt.trim() : '');

  return { overrides, from, ...(prompt ? { systemPrompt: prompt } : {}) };
}

export const MAX_PERSONA_PROMPT = 8000;
export const MAX_PERSONA_NAME = 60;

export function validatePersona(
  candidate: Pick<Persona, 'name' | 'systemPrompt'>,
  existing: Persona[],
  id?: string,
): string | undefined {
  const name = candidate.name?.trim() ?? '';
  if (!name) return 'A persona needs a name.';
  if (name.length > MAX_PERSONA_NAME) return `Name must be ${MAX_PERSONA_NAME} characters or fewer.`;
  if ((candidate.systemPrompt?.length ?? 0) > MAX_PERSONA_PROMPT) {
    return `The prompt must be ${MAX_PERSONA_PROMPT.toLocaleString()} characters or fewer.`;
  }
  const clash = existing.some((p) => p.id !== id && p.name.trim().toLowerCase() === name.toLowerCase());
  if (clash) return `You already have a persona called "${name}".`;
  return undefined;
}

const CIDR = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;
const K8S_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export function validateScope(scope: unknown): string | undefined {
  if (scope === undefined) return undefined;
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) {
    return 'Scope must be an object.';
  }
  const s = scope as Record<string, unknown>;

  if (s.tools !== undefined && (!Array.isArray(s.tools) || s.tools.some((t) => typeof t !== 'string'))) {
    return 'Tools must be a list of tool names.';
  }
  if (s.repo !== undefined && typeof s.repo !== 'boolean') return 'Repo must be true or false.';

  if (s.mcp !== undefined && (!Array.isArray(s.mcp) || s.mcp.some((m) => typeof m !== 'string' || !m.trim()))) {
    return 'Mcp must be a list of MCP server names.';
  }

  if (s.egress !== undefined) {
    if (!Array.isArray(s.egress)) return 'Egress must be a list of rules.';
    for (const rule of s.egress) {
      if (typeof rule !== 'object' || rule === null) return 'Each egress rule must be an object.';
      const r = rule as Record<string, unknown>;
      const hasNamespace = typeof r.namespace === 'string' && r.namespace !== '';
      const hasCidr = typeof r.cidr === 'string' && r.cidr !== '';
      if (hasNamespace === hasCidr) return 'Each egress rule needs exactly one of namespace or cidr.';
      if (hasNamespace && !K8S_NAME.test(String(r.namespace))) {
        return `"${String(r.namespace)}" is not a valid namespace name.`;
      }
      if (hasCidr && !CIDR.test(String(r.cidr))) {
        return `"${String(r.cidr)}" is not a valid CIDR — it needs the form 10.0.0.0/8.`;
      }
      if (r.ports !== undefined) {
        if (!Array.isArray(r.ports)) return 'Ports must be a list of numbers.';
        for (const port of r.ports) {
          if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
            return `"${String(port)}" is not a valid port.`;
          }
        }
      }
    }
  }
  return undefined;
}
