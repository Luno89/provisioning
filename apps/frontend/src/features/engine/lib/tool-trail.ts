export interface TrailCall {
  id: string
  name: string
  ok?: boolean | undefined
  running?: boolean | undefined
  digest?: string | undefined
  artifacts?: readonly unknown[] | undefined
  child?: unknown
}

export interface TrailGroup<T extends TrailCall> {
  name: string
  calls: T[]
  failed: number
  running: number
}

export interface ToolTrail<T extends TrailCall> {
  groups: TrailGroup<T>[]
  apart: T[]
  current: T[]
  made: NonNullable<T['artifacts']>[number][]
}

export const callRunning = (call: TrailCall): boolean => Boolean(call.running) || (call.ok === undefined && !call.digest)

export const callFailed = (call: TrailCall): boolean => !callRunning(call) && call.ok === false

const keptApart = (call: TrailCall): boolean => Boolean(call.child)

export function toolTrail<T extends TrailCall>(calls: readonly T[], live: boolean): ToolTrail<T> {
  const apart = calls.filter(keptApart)
  const folded = calls.filter((call) => !keptApart(call))
  const groups: TrailGroup<T>[] = []
  for (const call of folded) {
    let group = groups.find((entry) => entry.name === call.name)
    if (!group) {
      group = { name: call.name, calls: [], failed: 0, running: 0 }
      groups.push(group)
    }
    group.calls.push(call)
    if (callFailed(call)) group.failed += 1
    if (callRunning(call)) group.running += 1
  }
  const running = folded.filter(callRunning)
  const last = folded.at(-1)
  const current = running.length > 0 ? running : live && last ? [last] : []
  const made = folded.flatMap((call) => [...(call.artifacts ?? [])]) as ToolTrail<T>['made']
  return { groups, apart, current, made }
}
