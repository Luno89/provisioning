import type { RemovalState, RemovalStep } from '../types'
import { longDate } from '../../projects'

const STEP_NAMES: Record<RemovalStep, string> = {
  workflows: 'stopping its runs',
  projects: 'deleting its projects for good, the ones in Deleted projects too',
  apps: 'removing its apps from their clusters',
  workspaces: 'deleting its workspaces',
  secrets: 'deleting its secrets',
  mesh: 'removing its machines from the mesh',
  repositories: 'deleting its repositories',
  records: 'deleting its records',
  instance: 'removing its instance',
  koala: 'their own Koala deleting everything of theirs',
}

export function koalaAwayText(away: { machine?: string; since?: string }): string {
  const machine = away.machine ?? 'the machine their Koala is on'
  const since = away.since ? `, off since ${longDate(away.since)}, ${new Date(away.since).toISOString().slice(11, 16)} UTC` : ''
  return `Waiting for ${machine} to be back${since}. The removal goes on when it is.`
}

export const koalaProblemText = (problem: string): string => `Not removed yet: ${problem}`

const ORDER: RemovalStep[] = ['workflows', 'projects', 'repositories', 'apps', 'workspaces', 'secrets', 'mesh', 'records']

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
