import type { DependencyDown, EgressBehind, KoalaProcess, MemoryKeepingDown } from '../api/infrastructure'

export interface DependencyLine {
  key: string
  root: boolean
  refused: boolean
  label: string
  title: string
  text: string
  seenBy: string
}

const PROCESSES: Record<KoalaProcess, string> = {
  backend: 'this Koala\'s backend',
  'worker-engine': 'the engine worker',
  'worker-cluster': 'the cluster worker',
  'worker-host': 'the host worker',
}

const PROCESS_ORDER: readonly KoalaProcess[] = ['backend', 'worker-engine', 'worker-cluster', 'worker-host']

export const shownTime = (at: string): string =>
  new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

const listed = (names: readonly string[]): string =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

function seenBy(downs: readonly DependencyDown[]): string {
  const processes = PROCESS_ORDER.filter((process) => downs.some((down) => down.process === process))
  return `Seen by ${listed(processes.map((process) => PROCESSES[process]))}`
}

const capitalised = (name: string): string => name.replace(/^./, (letter) => letter.toUpperCase())

const isRootDown = (down: DependencyDown): boolean => down.dependency === 'root' && !down.refused

function lineFor(downs: readonly DependencyDown[], when: (at: string) => string): DependencyLine {
  const first = [...downs].sort((a, b) => a.since.localeCompare(b.since))[0]!
  if (first.refused) {
    return {
      key: `${first.dependency}:refused`,
      root: false,
      refused: true,
      label: 'Refused',
      title: first.where ?? first.name,
      text: `${capitalised(first.name)} refused, will not retry: ${first.reason}`,
      seenBy: seenBy(downs),
    }
  }
  if (isRootDown(first)) {
    return {
      key: 'root',
      root: true,
      refused: false,
      label: 'Root not answering',
      title: first.where ?? first.name,
      text: `Your instance has not reached Koala's root since ${when(first.since)}. Signing in through root and your addresses may not work; everything here keeps running.`,
      seenBy: seenBy(downs),
    }
  }
  return {
    key: first.dependency,
    root: false,
    refused: false,
    label: 'Not answering',
    title: first.name,
    text: `${capitalised(first.name)} isn't answering since ${when(first.since)}: ${first.reason}`,
    seenBy: seenBy(downs),
  }
}

export function dependencyLines(downs: readonly DependencyDown[], when: (at: string) => string = shownTime): DependencyLine[] {
  const byDependency = new Map<string, DependencyDown[]>()
  for (const down of downs) {
    const key = down.refused ? `${down.dependency}:refused` : down.dependency
    byDependency.set(key, [...(byDependency.get(key) ?? []), down])
  }
  const since = (group: readonly DependencyDown[]) => group.map((down) => down.since).sort()[0]!
  return [...byDependency.values()]
    .sort((a, b) => Number(isRootDown(b[0]!)) - Number(isRootDown(a[0]!)) || since(a).localeCompare(since(b)))
    .map((group) => lineFor(group, when))
}

export const dependencyTestId = (line: DependencyLine): string => {
  if (line.root) return 'attention-root'
  return line.refused ? 'attention-dependency-refused' : 'attention-dependency'
}

export const egressBehindLine = (behind: EgressBehind, when: (at: string) => string = shownTime): string =>
  `Sandboxes' egress proxy still holds grants from before ${when(behind.since)}${behind.refused ? ', and refused, will not retry' : ''}: ${behind.reason}`

export const memoryKeepingLine = (down: MemoryKeepingDown, when: (at: string) => string = shownTime): string =>
  `Koala has not consolidated your memories since ${when(down.since)}: ${down.reason}`
