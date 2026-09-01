import type { Tree } from './trees.js';
import type { TreeTypeSpec } from './tree-types.js';

/**
 * What the planner is asked, assembled from the row the handoff wrote.
 *
 * `tree-bootstrap` used to inline this as a single literal — "Goal: … Decompose this project into
 * actionable architecture and implementation tasks." — which meant everything Koala learned in the
 * conversation was thrown away at the boundary and the planner started from one sentence.
 *
 * Every part below is a field on the Tree, so widening the handoff widens the brief.
 */
export function buildPlanningBrief(
  tree: Pick<Tree, 'name' | 'goal' | 'brief' | 'context' | 'openQuestions'>,
  treeType?: Pick<TreeTypeSpec, 'label' | 'doneMeans'> | undefined,
): string {
  return [
    `Project: ${tree.name}`,
    ...(treeType?.label ? [`Kind: ${treeType.label}`] : []),
    ...(tree.goal ? ['', 'GOAL', tree.goal] : []),
    ...(treeType?.doneMeans ? ['', 'WHAT DONE MEANS FOR THIS KIND OF PROJECT', treeType.doneMeans] : []),
    ...(tree.brief ? ['', 'WHAT WAS ASKED FOR', tree.brief] : []),
    ...(tree.context
      ? ['', 'WHAT IS ALREADY KNOWN', 'Established before this project was created. Do not plan to'
         + ' rebuild something that already exists here.', tree.context]
      : []),
    ...(tree.openQuestions
      ? ['', 'STILL OPEN, AND OUT OF SCOPE', tree.openQuestions]
      : []),
    '',
    'Decompose this into the individual pieces of work that will produce it. Ask a question instead'
    + ' if it is still too vague to decompose.',
  ].join('\n');
}
