import type { PlanProposal } from './plan-proposals.js';

export interface StoryNow {
  id: string;
  title: string;
  status: string;
}

const FINISHED: Record<string, string> = { succeeded: 'has succeeded', cancelled: 'was cancelled' };

export function staleBecause(proposal: Pick<PlanProposal, 'leafPlan' | 'change'>, stories: readonly StoryNow[]): string | undefined {
  const about = [
    ...(proposal.leafPlan ? [{ leafId: proposal.leafPlan.leafId, title: proposal.leafPlan.leafTitle, was: undefined as string | undefined }] : []),
    ...(proposal.change?.before ?? []).map((before) => ({ leafId: before.leafId, title: before.title, was: before.status as string | undefined })),
  ];
  for (const { leafId, title, was } of about) {
    const story = stories.find((entry) => entry.id === leafId);
    if (!story) return `the story "${title}" is gone`;
    const finished = FINISHED[story.status];
    if (finished && story.status !== was) return `"${story.title}" ${finished} since this was proposed`;
  }
  return undefined;
}
