import { useState } from 'react'

const KEY = 'project-chat-closed'

const closedSet = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

export function useChatPanel(scope: string | undefined): { open: boolean; toggle: () => void } {
  const [closed, setClosed] = useState(closedSet)
  const open = !scope || !closed.has(scope)
  const toggle = () => {
    if (!scope) return
    const next = new Set(closed)
    if (next.has(scope)) next.delete(scope)
    else next.add(scope)
    setClosed(next)
    try {
      localStorage.setItem(KEY, JSON.stringify([...next]))
    } catch {
      return
    }
  }
  return { open, toggle }
}
