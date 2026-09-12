export interface SelectedEntity {
  kind: 'tree' | 'branch' | 'leaf'
  id: string
}

export const panel = 'bg-[var(--bark-800)] border border-[var(--bark-700)] rounded-xl'

export const resizeHandle = 'w-1.5 mx-1.5 shrink-0 cursor-col-resize rounded-full bg-transparent hover:bg-[var(--leaf)]/40 active:bg-[var(--leaf)]/60 transition-colors'
