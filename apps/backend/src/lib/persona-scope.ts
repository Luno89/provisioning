import { GITEA_EGRESS } from './leaf-checkout.js';
import type { PersonaPack, WorkspaceScope } from '@koala/harness-types';
import {
  egressForBindings,
  type EgressRule, type WorkspaceSpec, type WorkspaceLanguage, type WorkspaceBinding,
} from './workspace-spec.js';
import { capableImage, packageAccess } from './workspace-image-catalogue.js';
import type { WorkspaceImageSpec } from './workspace-image-seeds.js';

export function allowedTools(pack: Pick<PersonaPack, 'tools'> | null | undefined, available: string[]): string[] {
  const declared = pack?.tools;
  if (!declared?.length) return available;
  return available.filter((t) => declared.includes(t));
}

export function canRunLeaf(pack: Pick<PersonaPack, 'workspace'> | null | undefined): boolean {
  const w = pack?.workspace;
  if (!w) return false;
  return Object.keys(w).length > 0;
}

export function usesRepo(pack: Pick<PersonaPack, 'workspace'> | null | undefined): boolean {
  return pack?.workspace?.repo === true;
}

export function flattenPersona<T extends { id: string; basedOn?: string | undefined; systemPrompt?: string | undefined }>(
  persona: T,
  all: T[],
): T {
  const chain: T[] = [];
  const seen = new Set<string>();
  let node: T | undefined = persona;
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    chain.push(node);
    node = node.basedOn ? all.find((p) => p.id === node!.basedOn) : undefined;
  }

  return chain.reduceRight((base, layer) => ({
    ...base,
    ...layer,
    ...(layer.systemPrompt ?? base.systemPrompt ? { systemPrompt: layer.systemPrompt ?? base.systemPrompt } : {}),
  }), chain[chain.length - 1]!);
}

export function personaWorkspace(
  images: readonly WorkspaceImageSpec[],
  pack: Pick<PersonaPack, 'workspace'> | null | undefined,
  ids: { leafId: string; ownerId: string },
  work: {
    language?: string | undefined;
    bindings?: readonly { port: number; source: { namespace: string } }[] | undefined;
    files?: WorkspaceBinding[] | undefined;
    requires?: readonly string[] | undefined;
    checkout?: boolean | undefined;
  } = {},
): WorkspaceSpec {
  const scope: WorkspaceScope | undefined = pack?.workspace;

  const language = work.language ?? scope?.language;
  /**
   * Always resolved, never left for a later fallback. The image used to be decided twice — here
   * when a language was named, and again in `buildWorkspaceManifests` from a module constant when
   * one was not — so a pod's image came from a different place depending on the caller.
   */
  const image = capableImage(images, language, work.requires ?? []);
  /**
   * Still gated on the work naming a language or a requirement, which is what decided whether an
   * image was chosen at all before. A pod that named neither ran without registry env and without
   * registry egress, and widening that here would quietly change what every such run can install.
   */
  const chosen = Boolean(language || work.requires?.length);

  const packages = chosen ? packageAccess(images, language) : { env: [], egress: [] };

  const egress = dedupeEgress([
    ...((scope?.egress ?? []) as EgressRule[]),
    ...egressForBindings(work.bindings ?? []),
    ...(work.checkout ? [{ ...GITEA_EGRESS, ports: [...GITEA_EGRESS.ports] }] : []),
    ...packages.egress,
  ]);

  const env = [...(scope?.env ?? []), ...packages.env]
    .filter((e, i, all) => all.findIndex((o) => o.name === e.name) === i);

  return {
    leafId: ids.leafId,
    ownerId: ids.ownerId,
    ...(image ? { image } : {}),
    ...(scope?.cpu ? { cpu: scope.cpu } : {}),
    ...(scope?.memory ? { memory: scope.memory } : {}),
    ...(egress.length || scope?.egress ? { egress } : {}),
    ...(env.length ? { env } : {}),
    ...(work.files?.length ? { bindings: work.files } : {}),
  };
}

function dedupeEgress(rules: EgressRule[]): EgressRule[] {
  const out: EgressRule[] = [];
  for (const rule of rules) {
    const existing = rule.namespace
      ? out.find((r) => r.namespace === rule.namespace)
      : undefined;
    if (!existing) { out.push({ ...rule, ...(rule.ports ? { ports: [...rule.ports] } : {}) }); continue; }
    existing.ports = [...new Set([...(existing.ports ?? []), ...(rule.ports ?? [])])];
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function deepMergeConfig(base: unknown, layer: unknown): unknown {
  if (!isRecord(base) || !isRecord(layer)) return layer ?? base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(layer)) out[key] = deepMergeConfig(base[key], value);
  return out;
}

export function flattenPack<T extends { id: string; slug?: string | undefined; basedOn?: string | undefined }>(
  pack: T,
  all: readonly T[],
): T {
  const chain: T[] = [];
  const seen = new Set<string>();
  let node: T | undefined = pack;
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    chain.push(node);
    node = node.basedOn ? all.find((p) => p.id === node!.basedOn || p.slug === node!.basedOn) : undefined;
  }

  return chain.reduceRight((base, layer) => {
    const b = base as Record<string, unknown>;
    const l = layer as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...b, ...l };
    /**
     * The config objects merge field by field, so a pack based on another can raise one temperature
     * without restating its sampler, budget and every prompt section. This merged `overrides` when
     * a pack carried one; the same inheritance now has to reach the fields that replaced it.
     */
    for (const key of ['sampling', 'budget', 'prompt', 'model'] as const) {
      if (b[key] || l[key]) merged[key] = deepMergeConfig(b[key], l[key]);
    }
    if (b.workspace || l.workspace) {
      const bw = (b.workspace ?? {}) as Record<string, unknown>;
      const lw = (l.workspace ?? {}) as Record<string, unknown>;
      merged.workspace = {
        ...bw,
        ...lw,
        ...(bw.run || lw.run ? { run: { ...(bw.run as object ?? {}), ...(lw.run as object ?? {}) } } : {}),
      };
    }
    return merged as T;
  }, chain[chain.length - 1]!);
}
