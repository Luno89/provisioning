export const sizeText = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
};

export interface NoRoom {
  needed: number;
  free: number;
  why: string;
}

export function noRoomFor(needed: number | undefined, free: number): NoRoom | undefined {
  if (needed === undefined || needed <= free) return undefined;
  return { needed, free, why: `This needs ${sizeText(needed)}, and ${sizeText(free)} is free` };
}

export const freeBytes = (stats: { bavail: number | bigint; bsize: number | bigint }): number => Number(stats.bavail) * Number(stats.bsize);

export function alreadyThere(paths: readonly string[]): string {
  if (paths.length === 1) return `${paths[0]} is already there`;
  return `${paths.length} files are already there: ${paths.join(', ')}`;
}
