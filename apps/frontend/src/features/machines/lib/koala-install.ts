import type { KoalaInstallView } from '@koala/engine-core/koala-install'

export type InstallShown =
  | { kind: 'working'; title: string; line?: string }
  | { kind: 'failed'; title: string; why: string }

export function installShown(install: KoalaInstallView | undefined, machine: { id: string; online: boolean }): InstallShown | undefined {
  if (!install || install.machineId !== machine.id || install.state === 'ready') return undefined
  if (install.state === 'failed') return { kind: 'failed', title: install.title ?? 'its start', why: install.why ?? 'it gave no reason' }
  if (install.state === 'asked' && !install.stage) {
    return { kind: 'working', title: machine.online ? 'Asking it to put Koala on itself' : 'Koala is put on it once it connects' }
  }
  return { kind: 'working', title: install.title ?? 'Putting Koala on it', ...(install.line ? { line: install.line } : {}) }
}
