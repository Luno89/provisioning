import { Link, useNavigate } from '@tanstack/react-router'
import type { Agent } from '../../api/agents'
import AgentEditor, { type AgentSection } from './AgentEditor'
import AgentTryIt from './AgentTryIt'
import ProcedureEditor from './ProcedureEditor'
import { useState } from 'react'
import Memories from '../Memories'
import CheckList from '../Checks/CheckList'
import Coverage from '../Checks/Coverage'
import ComparePanel from '../Checks/ComparePanel'
import PracticesPanel from '../Checks/PracticesPanel'
import ProposalsPanel from '../Checks/ProposalsPanel'
import ChangesPanel from '../Checks/ChangesPanel'
import { useChanges, useLevel2Runs, usePractices, useProposals, useScenarios } from '../Checks/shared'
import { useAgents, useEngineAgents, useProcedureList } from './shared'
import { AGENT_FILES, type AgentFileId } from './agent-files'
import { describeUsage } from '../../lib/agent-groups'
import { checksSummary, describeChecks, describePractices, waitingFor } from '../../lib/subject-summary'

const EDITOR_SECTIONS: readonly AgentFileId[] = ['prompt', 'procedure', 'tools', 'hand-offs', 'workspace', 'settings']

const SAYS: Partial<Record<AgentFileId, string>> = {
  prompt: 'What it is told, every time it runs.',
  procedure: 'The steps it runs, and what those steps need it to be granted.',
  tools: 'What it may call, and how far it may go with them.',
  'hand-offs': 'The agents it may hand work to.',
  workspace: 'The workspace it runs in, and the hosts it may reach from it.',
  settings: 'Its name, what it is for, and how long its answers and conversations run.',
  memories: 'Its practices, and the memories it recalls.',
  checks: 'Every check that runs it, hands work to it, or uses its procedure.',
  coverage: 'How reliably it picks its tools, what no check covers yet, and two runs side by side.',
  changes: 'Tests, prompt changes and procedure changes proposed for it, waiting for you.',
  try: 'Run it with a message and watch what it does.',
}

export default function AgentFile({ agent, file }: { agent: Agent; file: AgentFileId }) {
  if (file === 'procedure') return <ProcedureFile agent={agent} />
  const title = AGENT_FILES.find((entry) => entry.id === file)?.title
  return (
    <div className="space-y-4">
      {file !== 'overview' && (
        <header>
          <h1 className="text-lg font-semibold text-slate-100">{title}</h1>
          <p className="text-xs text-slate-500">{SAYS[file]}</p>
        </header>
      )}
      <Body agent={agent} file={file} />
    </div>
  )
}

function Body({ agent, file }: { agent: Agent; file: AgentFileId }) {
  const navigate = useNavigate()
  const agents = useAgents()
  const engineAgents = useEngineAgents()
  const procedures = useProcedureList()
  const slugs = (agents.data ?? []).map((one) => one.slug)
  const procedureIds = (procedures.data?.procedures ?? []).map((one) => one.id)

  if (file === 'overview') return <Overview agent={agent} />
  if (EDITOR_SECTIONS.includes(file)) {
    return (
      <div className="space-y-3">
        <AgentEditor agent={agent} agents={agents.data ?? []} only={file as AgentSection} onSaved={() => undefined} onDeleted={() => void navigate({ to: '/studio/agents' })} />
      </div>
    )
  }
  if (file === 'try') return <AgentTryIt agent={engineAgents.data?.find((one) => one.slug === agent.slug)} />
  if (file === 'memories') {
    const recalling = (agents.data ?? []).filter((one) => one.recallsMemories && one.slug !== agent.slug).map((one) => one.slug)
    return (
      <div className="space-y-4">
        <PracticesPanel agent={agent.slug} />
        {agent.recallsMemories
          ? <Memories sharedWith={recalling} />
          : <p className="text-sm text-slate-500">{agent.name} recalls no memories — its procedure, {agent.procedure}, has no Recall memory step. Only its practices reach it.</p>}
      </div>
    )
  }
  if (file === 'checks') return <CheckList scope={{ agent: agent.slug }} agents={slugs} procedures={procedureIds} />
  if (file === 'coverage') {
    return (
      <div className="space-y-4">
        <Coverage scope={{ agent: agent.slug, heldTools: agent.tools }} />
        <details className="rounded-md border border-[var(--bark-700)] p-3">
          <summary className="cursor-pointer text-xs text-slate-400">Compare two runs of its checks</summary>
          <div className="pt-3"><ComparePanel scope={{ agent: agent.slug }} /></div>
        </details>
      </div>
    )
  }
  return (
    <div className="space-y-3">
      <ProposalsPanel agent={agent.slug} agents={slugs} procedures={procedureIds} />
      <ChangesPanel agent={agent.slug} />
      <ProposedNothing agent={agent} />
    </div>
  )
}

function ProcedureFile({ agent }: { agent: Agent }) {
  const agents = useAgents()
  const [choosing, setChoosing] = useState(false)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--bark-700)] px-6 py-2 text-xs text-slate-400">
        {agent.name} runs <span className="font-mono text-slate-200">{agent.procedure}</span>
        <button type="button" onClick={() => setChoosing(!choosing)} className="ml-2 text-sky-400 hover:underline">{choosing ? 'Close' : 'Run a different procedure'}</button>
      </div>
      {choosing && (
        <div className="shrink-0 border-b border-[var(--bark-700)] px-6 py-3">
          <AgentEditor agent={agent} agents={agents.data ?? []} only="procedure" onSaved={() => setChoosing(false)} />
        </div>
      )}
      <div className="min-h-0 flex-1">
        <ProcedureEditor key={agent.procedure} procedureId={agent.procedure} />
      </div>
    </div>
  )
}

function ProposedNothing({ agent }: { agent: Agent }) {
  const proposals = useProposals()
  const changes = useChanges()
  if (waitingFor(agent.slug, proposals.data ?? [], changes.data ?? []) > 0) return null
  return <p className="text-sm text-slate-500">Nothing is waiting. The memory keeper proposes tests and changes for {agent.name} here when something it sees calls for one.</p>
}

function Overview({ agent }: { agent: Agent }) {
  const scenarios = useScenarios()
  const runs = useLevel2Runs()
  const practices = usePractices()
  const proposals = useProposals()
  const changes = useChanges()
  const waiting = waitingFor(agent.slug, proposals.data ?? [], changes.data ?? [])

  const facts: { file: AgentFileId; says: string; tone?: string }[] = [
    { file: 'procedure', says: `runs ${agent.procedure}` },
    { file: 'tools', says: `holds ${agent.tools.length} tool${agent.tools.length === 1 ? '' : 's'}${agent.maxEffect && agent.maxEffect !== 'write' ? `, ${agent.maxEffect === 'read' ? 'only to read' : 'only to propose'}` : ''}` },
    { file: 'hand-offs', says: (agent.agents ?? []).length ? `hands work to ${(agent.agents ?? []).join(', ')}` : 'hands work to nobody' },
    { file: 'memories', says: `${describePractices(practices.data ?? [], agent.slug)} · ${agent.recallsMemories ? 'recalls the shared memories' : 'recalls no memories'}` },
    { file: 'checks', says: describeChecks(checksSummary(scenarios.data ?? [], runs.data ?? [], { agent: agent.slug })) },
    { file: 'changes', says: waiting === 0 ? 'nothing waiting for you' : `${waiting} waiting for you`, ...(waiting > 0 ? { tone: 'text-amber-300' } : {}) },
  ]

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-slate-100">
          {agent.name}
          <span className="font-mono text-sm font-normal text-slate-500">{agent.slug}</span>
          <span className="rounded border border-[var(--bark-600)] px-1.5 text-[10px] font-normal text-slate-400">{agent.mine ? 'yours' : 'built-in'}</span>
        </h1>
        <p className="max-w-3xl text-sm text-slate-400">{agent.description}</p>
      </header>

      <section className="space-y-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">How it is used</h2>
        {(agent.usedBy ?? []).length === 0
          ? <p className="text-sm text-slate-400">Nothing uses it yet: no conversation, tree type, procedure or other agent starts it.</p>
          : (
            <ul className="space-y-1 text-sm text-slate-300">
              {(agent.usedBy ?? []).map((usage) => <li key={`${usage.kind}-${usage.by}`}>{describeUsage(usage)}</li>)}
            </ul>
          )}
      </section>

      <section className="space-y-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">At a glance</h2>
        <ul className="divide-y divide-[var(--bark-800)] rounded-md border border-[var(--bark-700)]">
          {facts.map((fact) => (
            <li key={fact.file}>
              <Link to="/studio/agents/$slug/$part" params={{ slug: agent.slug, part: fact.file }} className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--bark-800)]/50">
                <span className="w-36 shrink-0 text-xs text-slate-400">{AGENT_FILES.find((entry) => entry.id === fact.file)?.title}</span>
                <span className={`min-w-0 flex-1 truncate text-sm ${fact.tone ?? 'text-slate-200'}`}>{fact.says}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
