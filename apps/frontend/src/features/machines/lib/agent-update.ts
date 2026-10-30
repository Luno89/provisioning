import type { AgentUpdateView } from '../api'

export type AgentUpdateTone = 'ok' | 'busy' | 'warn' | 'bad'

export interface AgentUpdateLine {
  tone: AgentUpdateTone
  text: string
}

const listed = (items: readonly string[]): string =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

export function agentUpdateLine(update: AgentUpdateView | undefined, online: boolean): AgentUpdateLine | undefined {
  if (!update) return undefined
  switch (update.state) {
    case 'current':
      return { tone: 'ok', text: 'Its agent is up to date.' }
    case 'behind':
      return online
        ? { tone: 'busy', text: 'Koala has a newer agent for it, which it is about to take.' }
        : { tone: 'busy', text: 'Koala has a newer agent for it, which it takes the next time it connects.' }
    case 'waiting':
      return {
        tone: 'busy',
        text: update.busyWith?.length
          ? `A newer agent is ready; it updates itself as soon as nothing runs on it (now: ${listed(update.busyWith)}).`
          : 'A newer agent is ready; it updates itself as soon as nothing runs on it.',
      }
    case 'updating':
      return { tone: 'busy', text: 'Its agent is updating itself.' }
    case 'failed':
      return {
        tone: 'bad',
        text: `Its agent could not update itself: ${update.reason ?? 'it did not say why'}. It keeps running the agent it has, and tries again the next time it connects.`,
      }
    case 'not-a-service':
      return {
        tone: 'warn',
        text: 'A newer agent is ready, but this one was not started as its service, so it cannot restart itself onto it. Run the command from My Machines on it again.',
      }
    case 'too-old':
      return {
        tone: 'warn',
        text: 'Its agent is too old to update itself. Run the command from My Machines on it again to install the current one, which keeps itself up to date.',
      }
  }
}
