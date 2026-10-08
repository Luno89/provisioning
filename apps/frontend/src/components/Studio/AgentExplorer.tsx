import { useState, type ReactNode } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { Bot } from 'lucide-react'
import type { Agent } from '../../api/agents'
import AgentEditor from './AgentEditor'
import AgentFile from './AgentFile'
import Explorer, { type ExplorerGroup } from './Explorer'
import { AGENT_FILES, isAgentFile, type AgentFileId } from './agent-files'
import { blankAgent } from './agent-forms'
import { errorMessage, useAgents, useProcedureList } from './shared'
import { useChanges, useLevel2Runs, useProposals, useScenarios } from '../Checks/shared'
import { groupAgents } from '../../lib/agent-groups'
import { checksSummary, waitingFor } from '../../lib/subject-summary'

export default function AgentExplorer() {
  const { slug, part } = useParams({ strict: false }) as { slug?: string; part?: string }
  const navigate = useNavigate()
  const agents = useAgents()
  const procedures = useProcedureList()
  const scenarios = useScenarios()
  const runs = useLevel2Runs()
  const proposals = useProposals()
  const changes = useChanges()
  const [fresh, setFresh] = useState<Agent>()

  const all = agents.data ?? []
  const agent = all.find((one) => one.slug === slug)
  const file: AgentFileId | undefined = part === undefined ? (slug ? 'overview' : undefined) : isAgentFile(part) ? part : undefined

  const badges = (target: string): Partial<Record<AgentFileId, ReactNode>> => {
    const checks = checksSummary(scenarios.data ?? [], runs.data ?? [], { agent: target })
    const waiting = waitingFor(target, proposals.data ?? [], changes.data ?? [])
    return {
      checks: checks.count === 0 ? null : checks.failing > 0
        ? <span className="ml-auto text-[10px] text-rose-400">{checks.failing} ✕</span>
        : <span className="ml-auto text-[10px] text-emerald-400">{checks.passing} ✓</span>,
      changes: waiting > 0 ? <span className="ml-auto rounded-full bg-amber-500/20 px-1.5 text-[10px] text-amber-300">{waiting}</span> : null,
    }
  }

  const groups: ExplorerGroup[] = groupAgents(all).map((group) => ({
    id: group.id,
    title: group.title,
    items: group.agents.map((one) => {
      const marks = badges(one.slug)
      return {
        id: one.slug,
        label: one.slug,
        mono: true,
        mine: one.mine,
        icon: Bot,
        link: { to: '/studio/agents/$slug', params: { slug: one.slug } },
        files: AGENT_FILES.filter((entry) => entry.id !== 'overview').map((entry) => ({
          id: entry.id,
          title: entry.title,
          icon: entry.icon,
          startsGroup: entry.startsGroup,
          badge: marks[entry.id],
          link: { to: '/studio/agents/$slug/$part', params: { slug: one.slug, part: entry.id } },
        })),
      }
    }),
  }))

  const start = (name: string) => {
    const newSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    if (!newSlug) return
    setFresh({ ...blankAgent(procedures.data?.procedures[0]?.id ?? 'tool-rounds'), slug: newSlug, name })
  }

  const path = [
    { label: 'Agents', link: { to: '/studio/agents' } },
    ...(fresh ? [{ label: `${fresh.name} (new)` }] : []),
    ...(!fresh && agent ? [{ label: agent.name, link: { to: '/studio/agents/$slug', params: { slug: agent.slug } } }] : []),
    ...(!fresh && agent && file && file !== 'overview' ? [{ label: AGENT_FILES.find((entry) => entry.id === file)?.title ?? file }] : []),
  ]

  return (
    <Explorer
      title="Agents"
      groups={groups}
      selected={slug ? { item: slug, file: file === 'overview' ? undefined : file } : undefined}
      path={path}
      onNew={start}
      newPlaceholder="New agent's name, then Enter"
      loading={agents.isPending}
      error={agents.isError ? errorMessage(agents.error) : undefined}
      fill={!fresh && Boolean(agent) && file === 'procedure'}
    >
      {fresh ? (
        <AgentEditor key={fresh.slug} agent={fresh} agents={all} onClose={() => setFresh(undefined)} onSaved={(saved) => { setFresh(undefined); void navigate({ to: '/studio/agents/$slug', params: { slug: saved.slug } }) }} />
      ) : !slug ? (
        <Welcome count={all.length} />
      ) : agents.isPending ? null : !agent ? (
        <p className="text-sm text-slate-400">There is no agent called “{slug}”.</p>
      ) : !file ? (
        <p className="text-sm text-slate-400">{agent.name} has no part called “{part}”.</p>
      ) : (
        <AgentFile key={`${agent.slug}-${file}`} agent={agent} file={file} />
      )}
    </Explorer>
  )
}

function Welcome({ count }: { count: number }) {
  return (
    <div className="max-w-xl space-y-2 pt-10 text-sm text-slate-400">
      <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-200"><Bot size={20} className="text-[var(--leaf)]" /> Agents</h1>
      <p>An agent is a procedure plus what it is allowed to touch: its prompt, the tools it is granted, the agents it can hand work to, and the workspace it runs in.</p>
      <p>The {count} agents on the left are grouped by how they are used. Open one to see what makes it up — each part opens here, like a file.</p>
    </div>
  )
}
