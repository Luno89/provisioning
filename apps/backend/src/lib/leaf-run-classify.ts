import type { Persona, PersonaPack } from '@koala/harness-types';
import type { Database } from './db-interface.js';
import type { Leaf } from './leaves.js';
import type { Tree } from './trees.js';
import type { TreeTypeSpec, ValidationRecipe } from './tree-types.js';
import type { WorkspaceLanguage } from './workspace-spec.js';
import type { ModelProvider, EndpointSource } from './model-registry.js';
import { resolveTreeType, leafValidationRecipe } from './tree-types.js';
import { conventionsOf, type FileConventions } from './tree-type-conventions.js';
import { packForLeaf } from './pack-seeds.js';
import { flattenPersona, usesRepo } from './persona-scope.js';
import { resolvePrompt } from './personas.js';
import { withBuiltIns } from './ownership.js';

export interface LeafRunClassification {
  treeOf: Tree | undefined;
  treeType: TreeTypeSpec | undefined;
  conventions: FileConventions | undefined;
  pack: PersonaPack | undefined;
  persona: Persona | null;
  wantsRepo: boolean;
  producesCode: boolean;
  isDocumentLeaf: boolean;
  outputPath: string | undefined;
  workLanguage: WorkspaceLanguage | undefined;
  leafRecipe: ValidationRecipe | undefined;
  systemPrompt: string | undefined;
  provider: ModelProvider;
  baseUrl: string;
  apiKey: string | undefined;
  endpointSource: EndpointSource;
}

export interface ClassifyLeafRunDeps {
  db: Pick<Database, 'getHarnessProfile' | 'getPersonas' | 'getBranches' | 'getTrees' | 'getPersonaPacks' | 'getTreeTypes'>;
  resolveBaseUrl: (
    ownerId: string, modelId: undefined, packEndpointId?: string | null,
  ) => Promise<{ provider: ModelProvider; baseUrl: string; apiKey?: string; source: EndpointSource }>;
}

export async function classifyLeafRun(
  deps: ClassifyLeafRunDeps,
  leaf: Pick<Leaf, 'ownerId' | 'branchId' | 'validationContract' | 'projectId' | 'packId'>,
): Promise<LeafRunClassification> {
  const { db, resolveBaseUrl } = deps;

  const profile = await db.getHarnessProfile(leaf.ownerId);
  const ownPersonas = withBuiltIns(await db.getPersonas(), leaf.ownerId, (p) => p.name);

  const branchOfLeaf = (await db.getBranches()).find((b) => b.id === leaf.branchId);
  const treeOf = branchOfLeaf?.treeId
    ? (await db.getTrees()).find((t) => t.id === branchOfLeaf.treeId)
    : undefined;
  const treeType = await resolveTreeType(db, leaf.ownerId, treeOf?.type);
  const conventions = conventionsOf(treeType);

  const ownPacks = withBuiltIns(await db.getPersonaPacks(), leaf.ownerId, (p) => p.slug);
  const pack = packForLeaf(ownPacks, leaf, profile?.packId);
  const wanted = pack?.personaId;
  const assigned = wanted ? ownPersonas.find((p) => p.id === wanted) : undefined;
  const persona = assigned ? flattenPersona(assigned, ownPersonas) : null;
  const wantsRepo = usesRepo(treeType);

  const producesCode = Boolean(
    (treeType && (treeType.produces === 'service' || treeType.validationRecipe || (treeType.files?.length ?? 0) > 0))
    || (!treeType && !pack?.output)
    || leaf.validationContract
    || leaf.projectId
    || (treeOf?.projectIds?.length ?? 0) > 0
    || wantsRepo,
  );

  const workLanguage = treeType?.language as WorkspaceLanguage | undefined;
  const outputPath = pack?.output;
  const isDocumentLeaf = Boolean(outputPath || !wantsRepo);
  const leafRecipe = leafValidationRecipe(
    leaf.validationContract
      ?? (isDocumentLeaf
        ? (treeType?.validationRecipe?.type === 'document' ? treeType.validationRecipe : undefined)
        : treeType?.validationRecipe),
  );

  const systemPrompt = resolvePrompt(persona);
  const { provider, baseUrl, apiKey, source: endpointSource } =
    await resolveBaseUrl(leaf.ownerId, undefined, pack?.model?.endpointId);

  return {
    treeOf, treeType, conventions, pack, persona, wantsRepo, producesCode, isDocumentLeaf,
    outputPath, workLanguage, leafRecipe, systemPrompt, provider, baseUrl, apiKey, endpointSource,
  };
}
