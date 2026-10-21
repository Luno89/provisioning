import { FileText, FlaskConical, Lightbulb, ListChecks, NotebookPen, Package, Server, Wrench } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ExplorerGroup } from './Explorer'
import type { EngineTool } from '../../api/engineTools'
import type { McpServer } from '../../api/mcp'
import type { DependencyView } from '../../api/workspaceDependencies'
import { useDependencies } from '../../api/workspaceDependencies'
import { useLevel2Runs, useScenarios } from '../Checks/shared'
import { useEngineTools, useMcpCatalogue } from './shared'
import { groupTools } from '../../lib/studio-groups'
import { checksSummary } from '../../lib/subject-summary'
import { groupServers } from './mcp-server-forms'

export const TOOL_FILES = [
  { id: 'definition', title: 'Definition', icon: FileText, says: 'What it does, the arguments it takes, the command it runs, and the workspace dependencies it needs.' },
  { id: 'checks', title: 'Checks', icon: FlaskConical, says: 'Every check that expects it to be called or chosen, or calls it as its step.' },
  { id: 'coverage', title: 'Coverage', icon: ListChecks, says: 'How reliably a model picks it when it should, and what no check covers yet.' },
  { id: 'learned', title: 'Learned notes', icon: Lightbulb, says: 'What runs taught about using it, shown beside it to every agent offered it once the bench shows it breaks nothing.' },
] as const

export const SERVER_FILES = [
  { id: 'runs', title: 'How it runs', icon: Server, says: 'Where it runs, and for one in the workspace the workspace dependencies that install it and the command that starts it. Saving a change here captures it again.' },
  { id: 'tools', title: 'Tools', icon: Wrench, says: 'What it serves, as it said when it was captured: which of them to offer, what each really does, and a note the model reads beside it.' },
  { id: 'notes', title: 'Notes', icon: NotebookPen, says: 'What you want every agent holding it to know, and what it depends on. The model reads both under the server\'s own instructions.' },
  { id: 'learned', title: 'Learned notes', icon: Lightbulb, says: 'What runs taught about using it and its tools, shown to every agent holding it once the bench shows it breaks nothing.' },
] as const

export const DEPENDENCIES_GROUP = 'Dependencies'
export const TOOLS_FOLDER = 'Tools'
export const SERVERS_FOLDER = 'MCP Servers'
export const DEPENDENCIES_SAY = 'What agents\' workspaces install so their tools, MCP servers and steps can run. Each tool, server or step names the ones it needs, and an agent\'s workspace image is built from them.'

export const toolItem = (name: string): string => `tool:${name}`
export const serverItem = (id: string): string => `server:${id}`
export const dependencyItem = (name: string): string => `dependency:${name}`

export function toolboxGroups(input: {
  tools: readonly EngineTool[]
  servers: readonly McpServer[]
  dependencies: readonly DependencyView[]
  badge?: ((tool: EngineTool, file: string) => ReactNode) | undefined
  serverBadge?: ((server: McpServer, file: string) => ReactNode) | undefined
}): ExplorerGroup[] {
  const tools: ExplorerGroup[] = groupTools([...input.tools]).map((group) => ({
    id: `tools-${group.id}`,
    title: group.title,
    folder: TOOLS_FOLDER,
    items: group.items.map((one) => ({
      id: toolItem(one.name),
      label: one.name,
      mono: true,
      mine: one.mine,
      icon: Wrench,
      link: { to: '/studio/tools/$name', params: { name: one.name } },
      files: TOOL_FILES.map((entry) => ({
        id: entry.id,
        title: entry.title,
        icon: entry.icon,
        link: { to: '/studio/tools/$name/$part', params: { name: one.name, part: entry.id } },
        badge: input.badge?.(one, entry.id) ?? null,
      })),
    })),
  }))
  const servers: ExplorerGroup[] = groupServers(input.servers).map((group) => ({
    id: `servers-${group.place}`,
    title: group.title,
    folder: SERVERS_FOLDER,
    items: group.servers.map((one) => ({
      id: serverItem(one.id),
      label: one.name,
      mono: true,
      icon: Server,
      link: { to: '/studio/mcp-servers/$id', params: { id: one.id } },
      files: SERVER_FILES.map((entry) => ({
        id: entry.id,
        title: entry.title,
        icon: entry.icon,
        link: { to: '/studio/mcp-servers/$id/$part', params: { id: one.id, part: entry.id } },
        badge: input.serverBadge?.(one, entry.id) ?? null,
      })),
    })),
  }))
  const dependencies: ExplorerGroup[] = input.dependencies.length ? [{
    id: 'dependencies',
    title: DEPENDENCIES_GROUP,
    folder: DEPENDENCIES_GROUP,
    items: input.dependencies.map((one) => ({
      id: dependencyItem(one.name),
      label: one.name,
      mono: true,
      mine: one.mine,
      icon: Package,
      link: { to: '/studio/dependencies/$name', params: { name: one.name } },
      files: [],
    })),
  }] : []
  return [...tools, ...servers, ...dependencies]
}

export function useToolbox(serverBadge?: (server: McpServer, file: string) => ReactNode) {
  const tools = useEngineTools()
  const catalogue = useMcpCatalogue({ polling: true })
  const dependencies = useDependencies()
  const scenarios = useScenarios()
  const runs = useLevel2Runs()
  const badge = (tool: EngineTool, file: string): ReactNode => {
    if (file !== 'checks') return null
    const checks = checksSummary(scenarios.data ?? [], runs.data ?? [], { tool: tool.name })
    if (checks.count === 0) return null
    return <span className={`ml-auto text-[10px] ${checks.failing > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>{checks.failing > 0 ? `${checks.failing} ✕` : `${checks.passing} ✓`}</span>
  }
  return {
    groups: toolboxGroups({ tools: tools.data ?? [], servers: catalogue.data?.servers ?? [], dependencies: dependencies.data ?? [], badge, ...(serverBadge ? { serverBadge } : {}) }),
    loading: tools.isPending || catalogue.isPending || dependencies.isPending,
    error: tools.error ?? catalogue.error ?? dependencies.error ?? undefined,
    tools,
    catalogue,
    dependencies,
  }
}
