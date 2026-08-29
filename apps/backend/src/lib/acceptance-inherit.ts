import { usableAcceptancePlan, type AcceptanceCheck } from './acceptance.js';

interface BranchLike {
  treeId?: string | undefined;
  acceptance?: unknown;
  updatedAt?: string | undefined;
  createdAt?: string | undefined;
}

export function inheritedAcceptance(
  treeId: string | undefined,
  branches: readonly BranchLike[],
): AcceptanceCheck[] {
  if (!treeId) return [];
  const when = (b: BranchLike) => b.updatedAt ?? b.createdAt ?? '';
  const candidates = branches
    .filter((b) => b.treeId === treeId)
    .map((b) => ({ at: when(b), plan: usableAcceptancePlan(b.acceptance) }))
    .filter((c) => c.plan.length > 0)
    .sort((a, b) => b.at.localeCompare(a.at));
  return candidates[0]?.plan ?? [];
}
