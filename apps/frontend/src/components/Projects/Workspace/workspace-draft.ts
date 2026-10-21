import type { WorkspaceFile, WorkspaceLine } from '../../../api/grove'

export interface WorkspaceDraft {
  packages: Record<string, string>
  languages: string[]
  env: { name: string; value: string }[]
  script: string
  needs: string[]
}

export function draftOf(file: WorkspaceFile | undefined, managers: readonly string[]): WorkspaceDraft {
  return {
    packages: Object.fromEntries(managers.map((manager) => [manager, (file?.packages?.[manager] ?? []).join(' ')])),
    languages: [...(file?.languages ?? [])],
    env: (file?.env ?? []).map((entry) => ({ ...entry })),
    script: file?.script ?? '',
    needs: [...(file?.needs ?? [])],
  }
}

const namesIn = (text: string): string[] => [...new Set(text.split(/[\s,]+/).map((name) => name.trim()).filter(Boolean))]

export function fileOf(draft: WorkspaceDraft): WorkspaceFile {
  const packages = Object.fromEntries(Object.entries(draft.packages).map(([manager, text]) => [manager, namesIn(text)] as const).filter(([, names]) => names.length > 0))
  const env = draft.env.filter((entry) => entry.name.trim()).map((entry) => ({ name: entry.name.trim(), value: entry.value }))
  return {
    ...(Object.keys(packages).length > 0 ? { packages } : {}),
    ...(draft.script.trim() ? { script: draft.script.trim() } : {}),
    ...(draft.languages.length > 0 ? { languages: [...draft.languages] } : {}),
    ...(env.length > 0 ? { env } : {}),
    ...(draft.needs.length > 0 ? { needs: [...draft.needs] } : {}),
  }
}

export function isEdited(draft: WorkspaceDraft, file: WorkspaceFile | undefined, managers: readonly string[]): boolean {
  return JSON.stringify(fileOf(draft)) !== JSON.stringify(fileOf(draftOf(file, managers)))
}

export function newOnMain(composed: readonly WorkspaceLine[], published: readonly WorkspaceLine[] | undefined): Set<number> {
  if (!published) return new Set()
  const before = new Set(published.map((line) => `${line.from}|${line.what}`))
  return new Set(composed.flatMap((line, at) => (before.has(`${line.from}|${line.what}`) ? [] : [at])))
}
