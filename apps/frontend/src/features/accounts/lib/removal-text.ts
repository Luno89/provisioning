import type { RemovalState, RemovalStep } from '../types'

const STEP_NAMES: Record<RemovalStep, string> = {
  workflows: 'stopping its runs',
  apps: 'removing its apps from their clusters',
  workspaces: 'deleting its workspaces',
  secrets: 'deleting its secrets',
  mesh: 'removing its machines from the mesh',
  repositories: 'deleting its repositories',
  records: 'deleting its records',
  instance: 'removing its instance',
}

const ORDER: RemovalStep[] = ['workflows', 'apps', 'workspaces', 'secrets', 'mesh', 'repositories', 'records']

export function removalText(state: RemovalState, steps: readonly RemovalStep[] = ORDER): string {
  if (state.state === 'none') return 'Waiting to start'
  if (state.state === 'finished') return 'Removed'
  if (state.state === 'failed') return `Stopped: ${state.reason}`
  const next = steps.find((step) => !state.done.includes(step))
  return next ? `${STEP_NAMES[next]} (${state.done.length + 1} of ${steps.length})` : 'Finishing'
}

export const confirmMatches = (typed: string, email: string): boolean =>
  typed.trim().toLowerCase() === email.toLowerCase()

export const refusalBlockers = (err: unknown): string[] =>
  (err as { response?: { data?: { blockers?: unknown } } } | undefined)?.response?.data?.blockers instanceof Array
    ? ((err as { response: { data: { blockers: string[] } } }).response.data.blockers)
    : []
