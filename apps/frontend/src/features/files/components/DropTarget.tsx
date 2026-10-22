import { useState, type ReactNode } from 'react'
import { droppedFiles, type PickedFile } from '../lib/file-drop'

export default function DropTarget({ onFiles, label, disabled = false, className = '', children }: {
  onFiles: (picked: PickedFile[]) => void
  label: string
  disabled?: boolean | undefined
  className?: string | undefined
  children: ReactNode
}) {
  const [over, setOver] = useState(0)
  const carriesFiles = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes('Files')
  return (
    <div
      data-testid="drop-target"
      aria-label={label}
      className={`relative ${className}`}
      onDragEnter={(event) => { if (!disabled && carriesFiles(event)) { event.preventDefault(); setOver((count) => count + 1) } }}
      onDragOver={(event) => { if (!disabled && carriesFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } }}
      onDragLeave={() => setOver((count) => Math.max(0, count - 1))}
      onDrop={(event) => {
        if (disabled || !carriesFiles(event)) return
        event.preventDefault()
        event.stopPropagation()
        setOver(0)
        void droppedFiles(event.dataTransfer).then((picked) => { if (picked.length) onFiles(picked) })
      }}
    >
      {children}
      {over > 0 && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded border-2 border-dashed border-[var(--leaf)] bg-[var(--bark-900)]/80 text-[12px] font-medium text-[var(--leaf-light)]">
          {label}
        </div>
      )}
    </div>
  )
}
