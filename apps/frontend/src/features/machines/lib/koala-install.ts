import type { KoalaInstallView } from '@koala/engine-core/koala-install'

export type InstallShown =
  | { kind: 'working'; title: string; line?: string }
  | { kind: 'failed'; said: string; why: string; retry: string }

const WORDS = {
  put: { asking: 'Asking it to put Koala on itself', later: 'Koala is put on it once it connects', working: 'Putting Koala on it', stopped: 'Koala could not be put here at', retry: 'Try again' },
  move: { asking: 'Asking it to move Koala onto itself', later: 'Koala moves onto it once it connects', working: 'Moving Koala here', stopped: 'Moving Koala here stopped at', retry: 'Move here' },
} as const

export function installShown(install: KoalaInstallView | undefined, machine: { id: string; online: boolean }): InstallShown | undefined {
  if (!install || install.machineId !== machine.id || install.state === 'ready') return undefined
  const words = install.move ? WORDS.move : WORDS.put
  if (install.state === 'failed') return { kind: 'failed', said: `${words.stopped} ${install.title ?? 'its start'}`, why: install.why ?? 'it gave no reason', retry: words.retry }
  if (install.state === 'asked' && !install.stage) return { kind: 'working', title: machine.online ? words.asking : words.later }
  return { kind: 'working', title: install.title ?? words.working, ...(install.line ? { line: install.line } : {}) }
}
