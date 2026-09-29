/**
 * Which agent runs each stage of a tree.
 *
 * A tree type may name an agent per stage; where it names none, these are used. Kept apart from the type seeds and
 * their validation so a workflow can import the defaults without dragging the rest of the type machinery into the
 * bundle Temporal ships to its workers.
 */
export const TREE_STAGES = ['plan', 'work', 'judge'] as const;
export type TreeStage = typeof TREE_STAGES[number];
/** The stages a type actually names — any of them may be left to the default. */
export type TreeStages = Partial<Record<TreeStage, string>>;

export const DEFAULT_STAGES: Readonly<Record<TreeStage, string>> = {
  plan: 'planner',
  work: 'leaf-worker',
  judge: 'grove-runner',
};

/** The agent per stage for a type: the one it names, and the default where it names none. */
export function stagesOf(type: { stages?: TreeStages | undefined } | undefined): Record<TreeStage, string> {
  const chosen = type?.stages ?? {};
  return {
    plan: chosen.plan || DEFAULT_STAGES.plan,
    work: chosen.work || DEFAULT_STAGES.work,
    judge: chosen.judge || DEFAULT_STAGES.judge,
  };
}
