/**
 * Resolving which configuration a turn actually runs under.
 *
 * ── WHY A CHAIN AND NOT A MERGE ──
 * Four things can set the same knob, and until now they did not all meet in one place: the built-in
 * constants, the adopted profile, a persona, and whatever the client posted. The chat route read
 * none of the first three — measured, not assumed — so a promoted default applied to leaf runs and
 * experiments while chat quietly ran the shipped values, and the promote dialog said "applies to
 * leaf runs too" in a way that read as "applies everywhere".
 *
 * The order is deliberate, and each step is a narrowing of scope:
 *
 *   built-in constants  — what the harness does when nobody has said otherwise
 *   adopted profile     — what THIS INSTALL decided, from an experiment
 *   persona             — what THIS CONVERSATION is for
 *   request             — what THIS TURN asked for
 *
 * A persona beats the profile because choosing one is an explicit act about the work in front of
 * you, while the profile is a standing default. The request beats the persona for the same reason
 * one step further in.
 *
 * ── PROVENANCE IS NOT OPTIONAL ──
 * Every layer records which keys it supplied. A run that cannot say where its temperature came from
 * is a number nobody can argue with, and this project has already been bitten once by a variant
 * named after a configuration it was no longer running.
 */
import type { Overrides, Persona } from '@koala/harness-types';
import type { HarnessProfile } from './harness-profile.js';
import { RESET_TO_DEFAULT } from './harness-profile.js';

export type { Persona };

/** Where a knob's value came from, for the run record and the UI. */
export type OverrideSource = 'profile' | 'persona' | 'request';

export interface ResolvedConfig {
  /** The bag to send. Built-in defaults are applied downstream by `applyOverrides`. */
  overrides: Overrides;
  /** Keys supplied by each layer, after the layers above it had their say. */
  from: Record<OverrideSource, string[]>;
  /**
   * The system prompt this turn should carry, or undefined to leave the mode's own prompt alone.
   *
   * Kept separate from `overrides` even though `systemPrompt` is also a registered knob: in chat
   * the prompt is composed into a message rather than sent as a parameter, and conflating the two
   * is how a persona prompt would end up as a sampler field the engine ignores.
   */
  systemPrompt?: string;
}

/**
 * Merges the layers and records who won each key.
 *
 * `RESET_TO_DEFAULT` in a later layer removes the key entirely rather than setting it — the opt-out
 * that lets a persona say "ignore the adopted default for this one" without knowing its value.
 */
export function resolveConfig(
  profile: HarnessProfile | null,
  persona: Persona | null,
  request: Overrides = {},
): ResolvedConfig {
  const layers: [OverrideSource, Overrides][] = [
    ['profile', profile?.overrides ?? {}],
    ['persona', persona?.overrides ?? {}],
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

  const from: Record<OverrideSource, string[]> = { profile: [], persona: [], request: [] };
  for (const [key, source] of owner) from[source].push(key);
  for (const source of Object.keys(from) as OverrideSource[]) from[source].sort();

  // The persona's own prompt wins over one carried in its overrides bag: the dedicated field is
  // what the editor writes, and a bag that disagrees with it is stale rather than intentional.
  const prompt = persona?.systemPrompt?.trim()
    || (typeof overrides.systemPrompt === 'string' ? overrides.systemPrompt.trim() : '');

  return { overrides, from, ...(prompt ? { systemPrompt: prompt } : {}) };
}

/** The longest a persona's prompt may be. A system message is paid for on every single turn. */
export const MAX_PERSONA_PROMPT = 8000;
export const MAX_PERSONA_NAME = 60;

/**
 * Rejects a persona that cannot be stored, returning the reason.
 *
 * Names are checked for uniqueness per owner because the picker shows names, and two personas
 * called "Reviewer" is a configuration you cannot choose between.
 */
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

/**
 * Checks a persona's scope — the part that decides what it can reach and do.
 *
 * ── WHY THIS IS VALIDATED AND THE PROMPT IS NOT ──
 * A bad prompt produces bad work. A bad scope produces a sandbox that is not one: `egress` becomes
 * a NetworkPolicy, and a rule naming the wrong namespace or a malformed CIDR fails OPEN in the
 * sense that matters — the pod comes up, the policy does not do what was meant, and nothing says
 * so. See WorkspaceService.create, which applies the Pod and the policy as one document for the
 * same reason.
 *
 * So the shape is checked here, at the edit, rather than discovered when a leaf reaches something
 * it should not have.
 */
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

  if (s.egress !== undefined) {
    if (!Array.isArray(s.egress)) return 'Egress must be a list of rules.';
    for (const rule of s.egress) {
      if (typeof rule !== 'object' || rule === null) return 'Each egress rule must be an object.';
      const r = rule as Record<string, unknown>;
      const hasNamespace = typeof r.namespace === 'string' && r.namespace !== '';
      const hasCidr = typeof r.cidr === 'string' && r.cidr !== '';
      // Both forms exist because a NodePort address does NOT work as a cidr — kube-proxy rewrites
      // the destination before the policy is evaluated. See EgressRule in workspace-spec.ts.
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
