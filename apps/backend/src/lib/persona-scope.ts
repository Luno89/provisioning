import { GITEA_EGRESS } from './leaf-checkout.js';
import type { PersonaPack, WorkspaceScope } from '@koala/harness-types';
import {
  imageForLanguage, capableImage, egressForBindings, packageAccess,
  type EgressRule, type WorkspaceSpec, type WorkspaceLanguage, type WorkspaceBinding,
} from './workspace-spec.js';

export function allowedTools(pack: Pick<PersonaPack, 'tools'> | null | undefined, available: string[]): string[] {
  const declared = pack?.tools;
  if (!declared?.length) return available;
  return available.filter((t) => declared.includes(t));
}

export function canRunLeaf(pack: Pick<PersonaPack, 'tools' | 'workspace'> | null | undefined): boolean {
  if (!pack) return false;
  const w = pack.workspace;
  return Boolean(pack.tools?.length || w?.language || w?.repo || w?.egress?.length);
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
  const image = language || work.requires?.length
    ? capableImage(language, work.requires ?? [])
    : undefined;

  const packages = image ? packageAccess(language) : { env: [], egress: [] };

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
