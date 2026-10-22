export interface StoryDrop {
  id: string;
  branch: string;
  paths: string[];
  at: string;
  by: string;
  state: 'waiting' | 'merged' | 'conflict';
  conflicts?: string[] | undefined;
  mergedAt?: string | undefined;
}

export const dropBranchName = (leafId: string, id: string): string => `drop/${leafId}/${id}`;

export function withDrop(drops: readonly StoryDrop[] | undefined, drop: StoryDrop): StoryDrop[] {
  return [...(drops ?? []).filter((entry) => entry.id !== drop.id), drop];
}

export const waitingDrops = (drops: readonly StoryDrop[] | undefined): StoryDrop[] => (drops ?? []).filter((drop) => drop.state === 'waiting');

export function dropSaid(drop: Pick<StoryDrop, 'state' | 'paths' | 'conflicts'>): string {
  const what = drop.paths.length === 1 ? drop.paths[0] : `${drop.paths.length} files`;
  if (drop.state === 'merged') return `${what} merged into the story's checkout`;
  if (drop.state === 'conflict') return `${what} could not be merged into the story's checkout: ${drop.conflicts?.join(', ') || 'they conflict with it'} changed there too; drop them again once the story is settled, or on the repository`;
  return `${what} will be merged into the story's checkout when it is next made`;
}
