import { useState } from 'react'
import { AlertTriangle, Folder, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { FileTree } from '../../ProjectEditor/FileTree.js'
import { EditorPane } from '../../ProjectEditor/EditorPane.js'
import { TabBar } from '../../ProjectEditor/TabBar.js'
import { useOpenFiles } from '../../ProjectEditor/useOpenFiles.js'
import { isDirty } from '../../ProjectEditor/shared.js'
import Reading from '../Reading'
import RepositoryFiles from '../../Files/RepositoryFiles'
import ProjectStoredFiles from '../../Files/ProjectStoredFiles'
import StoredFilePreview from '../../Files/StoredFilePreview'
import { panel, resizeHandle } from '../Workspace/shared.js'
import { useResizableWidth } from '../Workspace/useResizableWidth.js'
import { useProjectWork } from '../useProjectWork'
import { useRouteSync } from '../useRouteSync'

export default function ProjectFiles({ treeId, projectId }: { treeId?: string | undefined; projectId?: string | undefined }) {
  const { project, reading } = useProjectWork({ treeId, projectId })
  useRouteSync(treeId ? { kind: 'tree', treeId, page: 'files' } : projectId ? { kind: 'project', projectId, page: 'files' } : undefined)
  const {
    openFiles, activePath, setActivePath, active,
    loadingPath, savingPath, conflictPath,
    loadFile, openFile, closeFile, changeContent, saveFile,
  } = useOpenFiles(project?.id ?? '')
  const [storedOpen, setStoredOpen] = useState<string | undefined>()
  const explorer = useResizableWidth('files-explorer-width', 256, 180, () => Math.max(240, Math.round((typeof window !== 'undefined' ? window.innerWidth : 1200) * 0.35)))

  if (reading) return <Reading label="Reading its files…" className="px-3 py-6" />
  if (!project) return <p className="px-3 py-6 text-[12px] text-slate-400" data-testid="no-files">This work has no repository of its own, so there are no files to show.</p>

  return (
    <div className="flex-1 min-h-0 flex gap-0" data-testid="project-files">
      {explorer.isCollapsed ? null : (
        <>
          <div className={`${panel} shrink-0 flex flex-col overflow-hidden`} style={{ width: explorer.width }}>
            <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--bark-700)] shrink-0">
              <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                <Folder size={13} className="text-sky-400" /> Explorer
              </div>
              <button type="button" onClick={explorer.toggleCollapse} title="Collapse the explorer" aria-label="Collapse left panel" className="p-1 rounded hover:bg-[var(--bark-700)] text-slate-400 hover:text-slate-200 cursor-pointer">
                <PanelLeftClose size={14} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 min-h-0 space-y-3">
              <RepositoryFiles projectId={project.id}>
                {(onDropFiles) => <FileTree projectId={project.id} activePath={activePath} onOpen={(path) => { setStoredOpen(undefined); void openFile(path) }} onDropFiles={onDropFiles} />}
              </RepositoryFiles>
              <div className="border-t border-[var(--bark-700)] pt-2">
                <ProjectStoredFiles projectId={project.id} onOpen={setStoredOpen} />
              </div>
            </div>
          </div>
          <div role="separator" aria-orientation="vertical" aria-label="Resize file panel" onMouseDown={explorer.startResize(1)} onDoubleClick={explorer.toggleCollapse} title="Drag to resize, double-click to collapse" className={resizeHandle} />
        </>
      )}

      <div className={`${panel} flex-1 min-w-[160px] flex flex-col overflow-hidden`}>
        <div className="flex items-stretch border-b border-[var(--bark-700)] shrink-0 min-h-[36px]">
          {explorer.isCollapsed && (
            <button type="button" onClick={explorer.toggleCollapse} title="Show the explorer" aria-label="Expand left panel" className="px-2.5 py-1.5 text-slate-400 hover:text-slate-200 border-r border-[var(--bark-700)] flex items-center gap-1.5 text-xs shrink-0 cursor-pointer">
              <PanelLeftOpen size={14} /> <span className="text-[11px] font-medium hidden sm:inline">Explorer</span>
            </button>
          )}
          <div className="flex items-center min-w-0 flex-1 overflow-x-auto">
            <TabBar files={openFiles} activePath={activePath} onSelect={(path) => { setStoredOpen(undefined); setActivePath(path) }} onClose={closeFile} />
          </div>
        </div>
        {storedOpen && <StoredFilePreview scope={{ kind: 'project', projectId: project.id }} path={storedOpen} onClose={() => setStoredOpen(undefined)} />}
        {!storedOpen && !active && <div className="flex-1 flex items-center justify-center text-[13px] text-slate-500">Pick a file on the left to open it.</div>}
        {!storedOpen && active && (
          <div className="flex-1 flex flex-col min-h-0">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--bark-700)] shrink-0">
              <span className="text-[11px] text-slate-500 truncate">{active.path}</span>
              <button
                type="button"
                onClick={() => void saveFile(active.path)}
                disabled={!isDirty(active) || savingPath === active.path}
                className="text-[12px] px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-30 text-white cursor-pointer disabled:cursor-not-allowed"
              >
                {savingPath === active.path ? 'Saving…' : 'Save'}
              </button>
            </div>
            {conflictPath === active.path && (
              <div className="flex items-center gap-2 px-3 py-2 bg-amber-950/40 border-b border-amber-800/40 text-[12px] text-amber-300 shrink-0">
                <AlertTriangle size={13} className="shrink-0" />
                <span className="flex-1">Someone else changed this file since it was opened.</span>
                <button type="button" onClick={() => void loadFile(active.path)} className="text-amber-200 hover:text-white underline cursor-pointer">Reload latest</button>
              </div>
            )}
            {loadingPath === active.path
              ? <div className="flex-1 flex items-center justify-center text-[13px] text-slate-500">Loading…</div>
              : <div className="flex-1 min-h-0"><EditorPane file={active} onChange={changeContent} /></div>}
          </div>
        )}
      </div>
    </div>
  )
}
