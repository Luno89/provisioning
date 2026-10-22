import type { ProjectRemovalPreview, ProjectRemovalState, ProjectRemovalStep } from '../../types/project-removal'

const STEPS: { step: ProjectRemovalStep; doing: string }[] = [
  { step: 'workflows', doing: 'Stopping its runs and builds' },
  { step: 'apps', doing: 'Removing its apps from their clusters' },
  { step: 'workspaces', doing: 'Deleting its workspaces' },
  { step: 'secrets', doing: 'Deleting its secrets' },
  { step: 'repositories', doing: 'Deleting its repositories' },
  { step: 'files', doing: 'Deleting its files' },
  { step: 'records', doing: 'Deleting its trees, conversations and records' },
]

export function projectRemovalProgress(state: ProjectRemovalState): string {
  if (state.state === 'none') return 'Starting'
  if (state.state === 'finished') return 'Deleted'
  if (state.state === 'failed') return `Stopped: ${state.reason}`
  const next = STEPS.find((entry) => !state.done.includes(entry.step))
  return next ? `${next.doing} (${state.done.length + 1} of ${STEPS.length})` : 'Finishing'
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

export function projectRemovalLines(preview: ProjectRemovalPreview): string[] {
  return [
    ...preview.apps.map((app) => `The app “${app}” running on its cluster, with its databases and files`),
    ...(preview.repository ? [`The repository ${preview.repository}, with its history and its build webhook`] : []),
    ...(preview.files ? [`Its files: the folder ${preview.files.folder} on ${preview.files.server}, with everything in it`] : []),
    ...(preview.sharedOnHub ? ['Its copy on the hub, which is taken back first: everyone it was shared with loses it'] : []),
    ...preview.trees.map((tree) => `The tree “${tree.name}”, with ${plural(tree.leaves, 'leaf', 'leaves')}, their tasks and plans, ${plural(tree.conversations, 'conversation', 'conversations')} and its sandbox`),
    ...(preview.builds ? [`${plural(preview.builds, 'build', 'builds')} and their logs`] : []),
    'Its secrets, and anything still running for it',
  ]
}
