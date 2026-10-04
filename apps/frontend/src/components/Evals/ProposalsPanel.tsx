import { useState } from 'react'
import { acceptProposal, type ScenarioProposal } from '../../api/evals'
import { errorMessage } from '../../api/client'
import ScenarioEditor from './ScenarioEditor'
import { panelClass, primaryButton, quietButton, useDecideProposal, useProposals } from './shared'

function expectations(proposal: ScenarioProposal): string {
  const expect = proposal.scenario.expect
  return [
    expect.outcome ? `ends ${expect.outcome}` : '',
    expect.toolsCalled?.length ? `calls ${expect.toolsCalled.join(', ')}` : '',
    expect.toolsNotCalled?.length ? `never calls ${expect.toolsNotCalled.join(', ')}` : '',
    expect.toolsInOrder?.length ? `calls ${expect.toolsInOrder.join(' then ')}` : '',
  ].filter(Boolean).join('; ')
}

export default function ProposalsPanel({ agents, procedures }: { agents: string[]; procedures: string[] }) {
  const proposals = useProposals()
  const { accept, dismiss } = useDecideProposal()
  const [editing, setEditing] = useState<ScenarioProposal>()
  const waiting = (proposals.data ?? []).filter((proposal) => proposal.status === 'proposed')
  const error = accept.error ?? dismiss.error
  if (waiting.length === 0) return null

  return (
    <section className={`flex flex-col gap-3 ${panelClass}`}>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Proposed tests ({waiting.length})</h3>
      <p className="text-xs text-slate-500">Written from what went wrong — a failure, a judge's diagnosis, or you correcting an agent. Nothing runs until you accept it; then the bench runs it with the rest.</p>
      {error && (
        <p className="text-xs text-rose-300">
          {errorMessage(error)}
          {((error as { response?: { data?: { problems?: string[] } } }).response?.data?.problems ?? []).map((problem) => <span key={problem} className="block">{problem}</span>)}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {waiting.map((proposal) => (
          <li key={proposal.id} className="rounded border border-slate-800 p-3 text-sm">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-semibold text-slate-200">{proposal.scenario.name}</span>
              <span className="text-xs text-slate-500">for {proposal.scenario.agent}</span>
            </div>
            <p className="mt-1 text-xs text-slate-400">Why: {proposal.why}</p>
            <p className="mt-1 text-xs text-slate-300">Asks “{proposal.scenario.input.message}” and expects it {expectations(proposal) || 'to do what it describes'}.</p>
            <div className="mt-2 flex gap-2">
              <button type="button" disabled={accept.isPending} onClick={() => accept.mutate(proposal.id)} className={primaryButton}>Accept</button>
              <button type="button" onClick={() => setEditing(proposal)} className={quietButton}>Edit, then accept</button>
              <button type="button" disabled={dismiss.isPending} onClick={() => dismiss.mutate(proposal.id)} className={quietButton}>Dismiss</button>
            </div>
          </li>
        ))}
      </ul>
      {editing && (
        <ScenarioEditor
          scenario={editing.scenario}
          agents={agents}
          procedures={procedures}
          saveWith={(scenario) => acceptProposal(editing.id, scenario)}
          onClose={() => setEditing(undefined)}
          onSaved={() => setEditing(undefined)}
        />
      )}
    </section>
  )
}
