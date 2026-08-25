/* ════════════════ The persona-pack: persona × runtime × wire ════════════════ */

/**
 * One person to talk/work with, and the runtime it runs under — as a single declarative record.
 *
 * The hard-wired chat routes were two personalities of one capability (the harness's workbench
 * chat and Koala's productized conversation), each bound to rigid tools + UI + wire, and each
 * decided by code location rather than by configuration. A pack makes every knob a field:
 *
 *   - WHO        — the persona (systemPrompt, overrides) — resolved via lib/personas.ts
 *   - THINKER    — the model (id / kind / tempo) — the `resolveConfig` chain wins if unset
 *   - ENVIRONMENT — what it may touch (toolset, context state, MCP, sandbox)
 *   - DELIVERY   — which channels of the SHARED unified wire the UI should surface
 *   - WORKFLOW   — post-round side effects (settle leaf proposals, propose-only, none)
 *
 * One engine, one wire; a persona = a pack. Adding a conversation type is editing a pack, then
 * registering it — never editing a route.
 */

import type { Persona } from '@koala/harness-types';

/** Which tool environment a conversation may act in. */
export type Toolset = 'assistant' | 'workbench' | 'sandbox' | 'none';

/** How the conversation keeps state / memory. */
export type ContextKind = 'vault' | 'anchor';

/** Whether wire tool_calls become semantic frames, or are forwarded raw. */
export type ToolWire = 'semantic' | 'raw';

/** Post-round lifecycle. */
export type Workflow = 'workbench-settle' | 'propose-only' | 'none';

/**
 * Per-channel visibility on the unified stream. Every frame on the wire is a typed
 * `{ type, payload }`; this is which channels the UI renders, per persona. Nothing is dropped
 * at the engine — only at the surface.
 */
export interface DeliverySpec {
  /** Forward the provider's delta verbatim (lossless). */
  content: boolean;
  /** Forward `reasoning_content`. */
  thinking: boolean;
  /** How tool_calls are framed — semantic (toolAnnounce/toolResult) vs raw. */
  tools: ToolWire;
  /** Show the tool-result pill flipping. */
  toolResults: boolean;
  /** Show proposal cards (proposedTree / proposedSpec). */
  proposals: boolean;
  /** Show 'enabled' frames as services attach. */
  enable: boolean;
  /** Show workbench planning frames. */
  plan: boolean;
  /** Show usage / finish_reason / budget. */
  usage: boolean;
  /** Show control frames (interrupted, telemetry). */
  telemetry: boolean;
}

export interface Env {
  toolset: Toolset;
  /** Vault = durable titles/reset/handoff (koala). Anchor = the branch/tree it acts on. */
  context: ContextKind;
  /** Attach MCP services by name on demand (koala's lazy enable), or off. */
  mcp: 'session' | 'off';
  /** Only when toolset === 'sandbox'. */
  sandbox?: {
    driver: string;
    workspace?: string;
    egress: string;
  };
}

export interface PersonaPack {
  /** Registry id, matched by a route binder. */
  id: string;
  /** The persona this pack is about (name, systemPrompt, overrides live on it). */
  persona: Persona | string;
  /** The model. `'auto'` (or omitted) defers to the resolveConfig chain. */
  model?: { id?: string; kind?: string; tempo?: 'natural' | 'tight' };
  env: Env;
  delivery: DeliverySpec;
  workflow: Workflow;
}

export const KOALA_PACK: PersonaPack = {
  id: 'koala',
  persona: 'Koala', // resolved at runtime to the seeded chat-only persona
  env: { toolset: 'assistant', context: 'vault', mcp: 'session' },
  delivery: {
    content: true, thinking: true,
    tools: 'semantic', toolResults: true,
    proposals: true, enable: true, plan: false, usage: false, telemetry: true,
  },
  workflow: 'propose-only',
};

export const HARNESS_PACK: PersonaPack = {
  id: 'harness',
  persona: 'Harness', // the workbench persona family
  env: { toolset: 'workbench', context: 'anchor', mcp: 'session' },
  delivery: {
    content: true, thinking: true,
    tools: 'semantic', toolResults: true,
    proposals: true, enable: false, plan: true, usage: true, telemetry: true,
  },
  workflow: 'workbench-settle',
};

const REGISTRY: Record<string, PersonaPack> = {
  koala: KOALA_PACK,
  harness: HARNESS_PACK,
};

export function getPersonaPack(id: string): PersonaPack {
  const p = REGISTRY[id];
  if (!p) throw new Error(`No persona pack for "${id}"`);
  return p;
}