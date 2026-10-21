import type { ExplorerGroup } from './Explorer'

export interface Shelf {
  folder: string | undefined
  groups: ExplorerGroup[]
}

export function shelvesOf(groups: readonly ExplorerGroup[]): Shelf[] {
  const shelves: Shelf[] = []
  for (const group of groups) {
    const last = shelves.at(-1)
    if (group.folder && last?.folder === group.folder) last.groups.push(group)
    else shelves.push({ folder: group.folder, groups: [group] })
  }
  return shelves
}
