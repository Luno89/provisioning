import { useMcpCatalogue, useSaveMcpServer, errorMessage } from './Studio/shared'
import type { McpServer } from '../api/mcp'

function ServerRow({ server, projectId }: { server: McpServer; projectId: string }) {
  const save = useSaveMcpServer(server.id)
  const attached = (server.projects ?? []).includes(projectId)
  const toggle = () => save.mutate({ projects: attached ? (server.projects ?? []).filter((id) => id !== projectId) : [...(server.projects ?? []), projectId] })
  return (
    <li className="flex flex-col gap-0.5 py-1.5">
      <label className="flex items-center gap-2 text-[12px] text-slate-200">
        <input type="checkbox" className="accent-[var(--leaf-stem)]" checked={attached} disabled={save.isPending} onChange={toggle} />
        <span className="font-mono">{server.name}</span>
        {server.summary && <span className="text-slate-500">{server.summary}</span>}
      </label>
      {save.error && <p className="pl-6 text-[11px] text-rose-300">{errorMessage(save.error)}</p>}
    </li>
  )
}

export default function ProjectMcpServers({ projectId }: { projectId: string }) {
  const catalogue = useMcpCatalogue()
  const hosted = (catalogue.data?.servers ?? []).filter((server) => server.runs.where === 'hosted')
  const inWorkspace = (catalogue.data?.servers ?? []).filter((server) => server.runs.where === 'workspace')
  if (catalogue.isPending) return <p className="text-[12px] text-slate-500">Reading your MCP servers…</p>
  return (
    <div className="space-y-2">
      <p className="text-[12px] text-slate-400">The people on this project, once it is shared, reach the MCP servers attached here at their role's level. Your other servers stay yours.</p>
      {hosted.length === 0
        ? <p className="text-[12px] text-slate-500">You have no hosted MCP servers to attach.</p>
        : <ul className="divide-y divide-[var(--bark-800)]">{hosted.map((server) => <ServerRow key={server.id} server={server} projectId={projectId} />)}</ul>}
      {inWorkspace.length > 0 && <p className="text-[11px] text-slate-500">{inWorkspace.map((server) => server.name).join(', ')} run inside the project's workspace, so they are reached there without attaching.</p>}
    </div>
  )
}
