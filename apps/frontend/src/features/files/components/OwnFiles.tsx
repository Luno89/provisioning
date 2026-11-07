import StoredFiles from './StoredFiles'
import FileShares from './FileShares'

export default function OwnFiles() {
  return (
    <div className="mt-6 rounded-3xl border border-white/5 bg-slate-900/40 p-6" data-testid="own-files">
      <h4 className="mb-1 text-lg font-bold text-white">Files</h4>
      <p className="text-xs text-slate-400">
        Files that are not code are kept on your Koala. A project keeps its own on its Files page, and a chat outside a project keeps what is attached in it.
      </p>
      <div className="mt-4 rounded-xl border border-white/5 p-3" data-testid="personal-files">
        <StoredFiles scope={{ kind: 'mine' }} title="Your own files" />
      </div>
      <div className="mt-4">
        <h5 className="mb-1 text-xs font-semibold text-slate-300">Shared by a link</h5>
        <FileShares />
      </div>
    </div>
  )
}
