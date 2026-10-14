import type { ToolNote } from '../../api/evals'

export type NoteScope = { tool: string } | { server: string }

export const offeredName = (note: Pick<ToolNote, 'tool' | 'server'>): string | undefined =>
  note.tool ? (note.server ? `${note.server}__${note.tool}` : note.tool) : undefined

export function notesIn(notes: readonly ToolNote[], scope: NoteScope): ToolNote[] {
  if ('server' in scope) return notes.filter((note) => note.server === scope.server)
  return notes.filter((note) => offeredName(note) === scope.tool)
}

export function noteAbout(note: Pick<ToolNote, 'tool' | 'server'>): string {
  if (note.server && note.tool) return note.tool
  if (note.server) return `every tool of ${note.server}`
  return note.tool ?? ''
}

export function describeNotes(notes: readonly Pick<ToolNote, 'status'>[]): string {
  if (notes.length === 0) return 'nothing learned yet'
  const count = (status: NonNullable<ToolNote['status']>) => notes.filter((note) => (note.status ?? 'active') === status).length
  return [
    [count('active'), 'live'],
    [count('trial'), 'on trial'],
    [count('pending_review'), 'held for you'],
  ].filter(([n]) => (n as number) > 0).map(([n, what]) => `${n} ${what}`).join(' · ')
}

export function noteTrial(note: Pick<ToolNote, 'trial'>): string {
  const trial = note.trial
  if (!trial) return ''
  if (trial.unchecked) return 'not tried — no check uses this tool yet'
  const regressions = trial.regressions ?? []
  if (regressions.length > 0) return `regressed ${regressions.join(', ')} in bench run ${trial.runId ?? ''}`
  const better = trial.better ?? []
  const checks = `${trial.scenarios?.length ?? 0} check${trial.scenarios?.length === 1 ? '' : 's'}`
  return better.length > 0 ? `nothing regressed across ${checks}, and ${better.join(', ')} now pass${better.length === 1 ? 'es' : ''}` : `nothing regressed across ${checks}, but no check that failed before passed`
}
