/**
 * ── DUPLICATED, KNOWINGLY ──
 * Writes the drop `DropReader` in `apps/backend/src/files/lib/drops.ts` reads, which is the authority: one line of
 * settings, then for each file a line naming it and its size followed by its bytes. Built from the files themselves,
 * so the browser sends them as they are read from disk.
 */
export interface DropSettings {
  dir: string
  ref?: string
  message?: string
  leafId?: string
}

export interface DroppedCode {
  path: string
  file: Blob
}

const line = (value: unknown): string => `${JSON.stringify(value)}\n`

export const dropBody = (settings: DropSettings, files: readonly DroppedCode[]): Blob =>
  new Blob([line(settings), ...files.flatMap((one) => [line({ path: one.path, size: one.file.size }), one.file])])
