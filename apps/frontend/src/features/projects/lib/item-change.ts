import type { ItemChange } from '@koala/harness-types'

export const storyName = (change: ItemChange, leafId: string): string =>
  change.before.find((story) => story.leafId === leafId)?.title ?? change.names?.[leafId] ?? leafId

export function changeHeading(change: ItemChange): string {
  if (change.edit) {
    const { edit } = change
    const was = storyName(change, edit.leafId)
    return `${edit.rework && !edit.title && !edit.body && !edit.brief ? 'Rework' : 'Change'} “${was}”`
  }
  if (change.add) return change.add.leaves.length === 1 ? `Add “${change.add.leaves[0]!.title}” to “${change.add.branchTitle}”` : `Add ${change.add.leaves.length} stories to “${change.add.branchTitle}”`
  const cancelled = change.cancel ?? []
  return cancelled.length === 1 ? `Cancel “${storyName(change, cancelled[0]!)}”` : `Cancel ${cancelled.length} stories`
}

export interface ChangeRow {
  label: string
  before?: string | undefined
  after: string
}

export function editRows(change: ItemChange): ChangeRow[] {
  const edit = change.edit
  if (!edit) return []
  const story = change.before.find((entry) => entry.leafId === edit.leafId)
  const waits = (ids: readonly string[]) => (ids.length > 0 ? ids.map((id) => storyName(change, id)).join(', ') : 'nothing')
  const rows: ChangeRow[] = []
  if (edit.title) rows.push({ label: 'Title', before: story?.title, after: edit.title })
  if (edit.body) rows.push({ label: 'Goal', before: story?.body, after: edit.body })
  if (edit.dependsOn) rows.push({ label: 'Waits on', before: waits(story?.dependsOn ?? []), after: waits(edit.dependsOn) })
  for (const task of edit.addTasks ?? []) rows.push({ label: 'New task', after: `${task.title} — done means: ${task.doneMeans}` })
  for (const id of edit.dropTasks ?? []) {
    const task = story?.tasks.find((entry) => entry.id === id)
    rows.push({ label: 'Drop task', after: task ? `${task.title} (${task.status})` : id })
  }
  if (edit.rework) rows.push({ label: 'Rework', after: 'Work it again' })
  return rows
}
