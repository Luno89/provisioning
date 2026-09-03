import type { Persona } from '@koala/harness-types';

export type { Persona };

/**
 * The prompt a run uses. This was `resolveConfig`, which layered profile over pack over request and
 * reported which layer won each key. There are no layers now — every value is on the pack — so all
 * that is left is the persona's own prompt.
 */
export function resolvePrompt(persona?: { systemPrompt?: string } | null): string | undefined {
  const prompt = persona?.systemPrompt?.trim();
  return prompt || undefined;
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

/** Shared by tree-type validation — a tree type's `egress` is the same rule shape a persona's scope used to carry. */
export function validateEgressRules(egress: unknown): string | undefined {
  if (egress === undefined) return undefined;
  if (!Array.isArray(egress)) return 'Egress must be a list of rules.';
  for (const rule of egress) {
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
  return undefined;
}
