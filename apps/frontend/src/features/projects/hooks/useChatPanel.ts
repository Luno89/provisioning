import { useState } from 'react'

const closedSet = (key: string): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

export function useRemembered(key: string, scope: string | undefined): { open: boolean; toggle: () => void } {
  const [closed, setClosed] = useState(() => closedSet(key))
  const open = !scope || !closed.has(scope)
  const toggle = () => {
    if (!scope) return
    const next = new Set(closed)
    if (next.has(scope)) next.delete(scope)
    else next.add(scope)
    setClosed(next)
    try {
      localStorage.setItem(key, JSON.stringify([...next]))
    } catch {
      return
    }
  }
  return { open, toggle }
}

export const useChatPanel = (scope: string | undefined) => useRemembered('project-chat-closed', scope)
