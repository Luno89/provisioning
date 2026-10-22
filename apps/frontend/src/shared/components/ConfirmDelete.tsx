export default function ConfirmDelete({ prompt, confirmLabel, onConfirm, onCancel, pending = false }: {
  prompt: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  pending?: boolean
}) {
  return (
    <div className="flex items-center gap-2 text-[12px] px-2 py-1.5 rounded-md bg-amber-950/30 border border-amber-800/40" data-testid="confirm-delete">
      <span className="flex-1 text-amber-300">{prompt}</span>
      <button
        type="button"
        onClick={onConfirm}
        disabled={pending}
        className="px-2 py-1 rounded-md bg-red-700 hover:bg-red-600 text-white cursor-pointer disabled:opacity-50 shrink-0"
      >
        {pending ? 'Deleting…' : confirmLabel}
      </button>
      <button type="button" onClick={onCancel} className="px-2 py-1 rounded-md hover:bg-[var(--bark-700)] cursor-pointer shrink-0 text-slate-300">
        Keep
      </button>
    </div>
  )
}
