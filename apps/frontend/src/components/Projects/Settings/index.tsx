import type { ReactNode } from 'react'
import Reading from '../Reading'
import AutoModeSwitch from '../../AutoMode/AutoModeSwitch'
import { useTreeAutoMode } from '../../AutoMode/useAutoMode'
import { useProjectWork } from '../useProjectWork'
import { useRouteSync } from '../useRouteSync'
import { TreeModels } from '../Workspace/TreeModels'
import { ProjectRelease } from '../Workspace/ProjectRelease'
import { LiveCustomizations } from './LiveCustomizations'
import { ClientImport } from './ClientImport'
import { useClientImport } from './useClientImport'
import { TreeDeletePanel } from '../Workspace/TreeDeletePanel'
import { ProjectDeletePanel } from '../Workspace/ProjectDeletePanel'
import { TreeWorkspaceFilePanel } from '../Workspace/TreeWorkspaceFilePanel'
import { TreeSandboxPanel } from '../Workspace/TreeSandboxPanel'

function Section({ title, children, danger = false }: { title: string; children: ReactNode; danger?: boolean }) {
  return (
    <section className={`rounded-lg border ${danger ? 'border-red-900/50' : 'border-[var(--bark-700)]'} bg-[var(--bark-900)]/40`}>
      <h2 className={`px-3 py-2 text-[10px] font-black uppercase tracking-widest border-b ${danger ? 'text-red-400 border-red-900/50' : 'text-slate-500 border-[var(--bark-700)]'}`}>{title}</h2>
      <div className="p-3 text-[12px]">{children}</div>
    </section>
  )
}

function TreeAutoMode({ treeId }: { treeId: string }) {
  return (
    <AutoModeSwitch
      state={useTreeAutoMode(treeId)}
      label="Auto mode"
      explain="Runs working on this tree never stop to ask you before a call. Calls inside its sandbox never ask anyway."
    />
  )
}

export default function ProjectSettings({ treeId, projectId, onDeleted }: {
  treeId?: string | undefined
  projectId?: string | undefined
  onDeleted: () => void
}) {
  const { tree, project, reading } = useProjectWork({ treeId, projectId })
  const imported = useClientImport(project?.id)
  useRouteSync(treeId ? { kind: 'tree', treeId, page: 'settings' } : projectId ? { kind: 'project', projectId, page: 'settings' } : undefined)

  if (reading) return <Reading label="Reading its settings…" className="px-3 py-6" />
  if (!tree && !project) return <p className="px-3 py-6 text-[12px] text-slate-400">There is nothing here: it may have been deleted.</p>

  return (
    <div className="h-full min-h-0 overflow-y-auto" data-testid="project-settings">
      <div className="max-w-3xl mx-auto flex flex-col gap-3 pb-6">
        {tree && (
          <Section title="Models">
            <TreeModels treeId={tree.id} />
          </Section>
        )}
        {tree && (
          <Section title="Auto mode">
            <TreeAutoMode treeId={tree.id} />
          </Section>
        )}
        {tree && (
          <Section title="Workspace">
            <TreeWorkspaceFilePanel treeId={tree.id} />
          </Section>
        )}
        {tree && (
          <Section title="Sandbox">
            <TreeSandboxPanel treeId={tree.id} />
          </Section>
        )}
        {project && (
          <Section title="Releases">
            <ProjectRelease projectId={project.id} />
          </Section>
        )}
        {project && imported.data && (imported.data.open || imported.data.import) && (
          <Section title="Start from a client's database">
            <ClientImport projectId={project.id} view={imported.data} />
          </Section>
        )}
        {project && (
          <Section title="Made in the live app">
            <LiveCustomizations projectId={project.id} />
          </Section>
        )}
        {tree && (
          <Section title="Delete the tree" danger>
            <TreeDeletePanel treeId={tree.id} treeName={tree.name} onDeleted={onDeleted} />
          </Section>
        )}
        {project && (
          <Section title="Delete the project" danger>
            <ProjectDeletePanel projectId={project.id} onDeleted={onDeleted} />
          </Section>
        )}
      </div>
    </div>
  )
}
