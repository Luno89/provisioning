import {
  draftId, type WorkflowStageDefinition, type WorkflowStageGroup, type WorkflowStageLoop,
  type WorkflowStageType, type LoopType,
} from '../shared.js';

export function blankStage(stage: WorkflowStageType): WorkflowStageDefinition {
  return { id: draftId('stage'), name: STAGE_LABELS[stage], stage };
}

export function blankGroup(): WorkflowStageGroup {
  return { id: draftId('group'), name: 'New group', containerType: 'group', children: [] };
}

export function blankLoop(): WorkflowStageLoop {
  return {
    id: draftId('loop'), name: 'New loop', containerType: 'loop', loopType: 'count', maxIterations: 3, children: [],
  };
}

export const STAGE_LABELS: Record<WorkflowStageType, string> = {
  release: 'Release dependents',
  judge: 'Judge',
  land: 'Land',
  resolve: 'Resolve landing conflicts',
  accept: 'Accept request',
  replan: 'Replan',
};

export const STAGE_HINTS: Record<WorkflowStageType, string> = {
  release: 'Unblocks any sibling leaves that were waiting on this one.',
  judge: 'Runs the tree type\'s judge pack over the finished work. A thrown error here is swallowed unless "Optional" is unchecked.',
  land: 'Merges the branch into its parent.',
  resolve: 'Runs the merger pack to resolve any leaves the land stage couldn\'t merge cleanly.',
  accept: 'Marks the request accepted once its branch has actually landed.',
  replan: 'Re-plans any children still pending against the now-updated branch.',
};

export const LOOP_TYPE_LABELS: Record<LoopType, string> = {
  count: 'Repeat N times',
  until: 'Repeat until it passes',
  forEach: 'For each item',
};

export const LOOP_TYPE_HINTS: Record<LoopType, string> = {
  count: 'Runs its stages exactly this many times, regardless of outcome.',
  until: 'Retries its stages, up to a cap, until one full pass succeeds.',
  forEach: 'Runs once per item in an earlier stage\'s output array, with each item addressable by index.',
};
