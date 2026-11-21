import { ARCHIVE_DAYS, type DeletionPart, type DeletionProgress, type ProjectDeletionMode, type ProjectRemovalPreview, type StoppingWork } from '../types/project-removal'

const DAY_MS = 86_400_000

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

export const keptUntilFrom = (now: Date): string => new Date(now.getTime() + ARCHIVE_DAYS * DAY_MS).toISOString()

export const longDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })

export interface ConfirmationText {
  now: string[]
  kept?: { until: string; lines: string[] }
}

export function confirmationText(preview: ProjectRemovalPreview, mode: ProjectDeletionMode, keptUntil: string): ConfirmationText {
  const now = [
    ...preview.apps.map((app) => `The app “${app}” running on its cluster, with its databases and files`),
    'Its secrets',
    'Its workspaces, and anything still running for it',
  ]
  const kept = [
    ...(preview.repository ? [`Its code: the repository ${preview.repository}, with its history`] : []),
    ...preview.trees.map((tree) => `The tree “${tree.name}”, with ${plural(tree.leaves, 'leaf', 'leaves')}, their tasks and plans and ${plural(tree.conversations, 'conversation', 'conversations')}`),
    ...(preview.builds ? [`${plural(preview.builds, 'build', 'builds')} and their logs`] : []),
    ...(preview.files ? [`The files you uploaded: the folder ${preview.files.folder} on ${preview.files.server}`] : []),
  ]
  return mode === 'permanent' ? { now: [...now, ...kept] } : { now, kept: { until: longDate(keptUntil), lines: kept } }
}

function workLine(work: StoppingWork): string {
  const what = work.what ?? work.type
  switch (work.state) {
    case 'stopping': return `${what}: stopping`
    case 'stopped': return `${what}: stopped`
    case 'restarting': return `${what}: ${work.worker ?? 'its worker'} not answering: restarting`
    case 'restarted': return `${what}: ${work.worker ?? 'its worker'} restarted`
  }
}

const PARTS: { part: DeletionPart; name: string; done: (count: number) => string }[] = [
  { part: 'apps', name: 'Apps', done: (count) => `${count} removed` },
  { part: 'workspaces', name: 'Workspaces', done: (count) => `${count} deleted` },
  { part: 'secrets', name: 'Secrets', done: (count) => `${count} deleted` },
  { part: 'repositories', name: 'Code', done: (count) => `${plural(count, 'repository', 'repositories')} deleted` },
  { part: 'files', name: 'Files you uploaded', done: (count) => `${count} deleted` },
  { part: 'records', name: 'Trees, chats, runs and builds', done: (count) => `${plural(count, 'record', 'records')} deleted` },
]

export function deletionLines(progress: DeletionProgress | undefined): string[] {
  if (!progress) return []
  const parts = PARTS.flatMap(({ part, name, done }) => {
    const at = progress.parts[part]
    if (!at) return []
    if (at.state === 'deleted') return [`${name}: ${done(at.deleted)}`]
    if (at.left !== undefined) return [`${name}: ${at.left} left, ${done(at.deleted)}`]
    return [`${name}: deleting`]
  })
  return [...progress.work.map(workLine), ...parts]
}

export function deletionHeadline(progress: DeletionProgress | undefined): string {
  if (progress?.phase === 'deleted') return 'Deleted for good'
  if (progress?.phase === 'archived' && progress.keptUntil) return `Deleted — kept until ${longDate(progress.keptUntil)}`
  if (progress?.problem) return `Not deleted yet: ${progress.problem}`
  return 'Deleting'
}

export const latestProgress = (a: DeletionProgress | undefined, b: DeletionProgress | undefined): DeletionProgress | undefined =>
  !a ? b : !b ? a : a.seq >= b.seq ? a : b
