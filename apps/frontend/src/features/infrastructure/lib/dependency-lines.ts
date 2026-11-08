import type { DependencyDown, KoalaProcess } from '../api/infrastructure'

export interface DependencyLine {
  key: string
  root: boolean
  label: string
  title: string
  text: string
  seenBy: string
}

const SEEN_BY: Record<KoalaProcess, string> = {
  backend: 'seen by this Koala\'s backend',
  'worker-engine': 'seen by the engine worker',
  'worker-cluster': 'seen by the cluster worker',
  'worker-host': 'seen by the host worker',
}

export const shownTime = (at: string): string =>
  new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function dependencyLine(down: DependencyDown, when: (at: string) => string = shownTime): DependencyLine {
  const key = `${down.process}:${down.dependency}`
  if (down.dependency === 'root') {
    return {
      key,
      root: true,
      label: 'Root not answering',
      title: down.where ?? down.name,
      text: `Your instance has not reached Koala's root since ${when(down.since)}. Signing in through root and your addresses may not work; everything here keeps running.`,
      seenBy: SEEN_BY[down.process],
    }
  }
  return {
    key,
    root: false,
    label: 'Not answering',
    title: down.name,
    text: `${down.name} isn't answering since ${when(down.since)}: ${down.reason}`,
    seenBy: SEEN_BY[down.process],
  }
}

export function dependencyLines(downs: readonly DependencyDown[], when: (at: string) => string = shownTime): DependencyLine[] {
  const ordered = [...downs].sort((a, b) => Number(b.dependency === 'root') - Number(a.dependency === 'root') || a.since.localeCompare(b.since))
  return ordered.map((down) => dependencyLine(down, when))
}
