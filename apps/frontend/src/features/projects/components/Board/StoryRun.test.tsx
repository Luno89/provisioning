import type { ReactElement } from 'react'
import { fireEvent, render as plainRender, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { EngineEvent } from '../../../../api/engine'
import { applyInstanceEvents } from '../../../../lib/engine-run-state'
import { StoryRun } from './StoryRun'
import { WorkSourceContext, localWorkSource } from '../../lib/work-source'

const source = { ...localWorkSource, getProcedure: async (id: string) => ({ procedure: { id, nodes: [] }, mine: false }), listExtensions: async () => [] } as never

const render = async (ui: ReactElement) => {
  plainRender(<QueryClientProvider client={new QueryClient()}><WorkSourceContext.Provider value={source}>{ui}</WorkSourceContext.Provider></QueryClientProvider>)
  await screen.findByTestId('canvas')
}

vi.mock('../../../../lib/procedure-drafts', () => ({ canvasContextFor: () => ({}), groupPathIn: (_procedure: unknown, nodeId: string) => nodeId.split('.').slice(0, -1) }))
vi.mock('../../../../components/Studio/ProcedureCanvas', () => ({
  default: ({ procedure, path, states, editable, onOpenGroup }: { procedure: { id: string }; path: string[]; states: Record<string, string>; editable: boolean; onOpenGroup: (id: string) => void }) => (
    <div data-testid="canvas" data-editable={String(editable)}>
      {`${procedure.id} at [${path.join('/')}] ${JSON.stringify(states)}`}
      <button type="button" onClick={() => onOpenGroup('check')}>open check</button>
    </div>
  ),
}))

const events: EngineEvent[] = [
  { type: 'run.started', runId: 'exec-2', at: 't0', agentId: 'executor', loopId: 'do-one-task' },
  { type: 'node.entered', runId: 'exec-2', at: 't1', nodeId: 'claim' },
  { type: 'node.exited', runId: 'exec-2', at: 't1', nodeId: 'claim' },
  { type: 'node.entered', runId: 'exec-2', at: 't2', nodeId: 'turn.call' },
  { type: 'model.requested', runId: 'exec-2', at: '2026-10-11T23:44:02Z', nodeId: 'turn.call', toolNames: ['run_command'] },
  { type: 'thinking', runId: 'exec-2', at: 't3', nodeId: 'turn.call', delta: 'The Save button has no text, so match it by class.' },
  { type: 'tool.called', runId: 'exec-2', at: 't3', nodeId: 'turn.call', callId: 'c1', name: 'run_command', args: '{"command":"odoo-e2e --keep delivery_instructions e2e/delivery-slip.spec.ts"}' },
  { type: 'tool.result', runId: 'exec-2', at: 't4', nodeId: 'turn.call', callId: 'c1', ok: false, digest: 'odoo-e2e: FAILED' },
  { type: 'tool.called', runId: 'exec-2', at: 't5', nodeId: 'tools.approve', callId: 'c2', name: 'run_command', args: '{"command":"odoo-e2e --keep delivery_instructions e2e/delivery-slip.spec.ts"}' },
  { type: 'notice', runId: 'exec-2', at: 't5', level: 'warn', message: 'run_command wants to run; allow it?' },
]

const runOf = (list: EngineEvent[]) => applyInstanceEvents([], list)[0]!

describe('a run on a story\'s page', () => {
  it('draws its procedure read-only, inside the group of the step it is on, with that step lit', async () => {
    await render(<StoryRun run={runOf(events)} events={events} />)

    const canvas = screen.getByTestId('canvas')
    expect(canvas.dataset.editable).toBe('false')
    expect(canvas.textContent).toContain('do-one-task at [turn] {"call":"running"}')
    expect(screen.getByTestId('story-run-now').textContent).toContain('turn.call')
  })

  it('lets the person look elsewhere, and go back to following it', async () => {
    await render(<StoryRun run={runOf(events)} events={events} />)

    fireEvent.click(screen.getByRole('button', { name: '← out of turn' }))
    expect(screen.getByTestId('canvas').textContent).toContain('at [] {"claim":"done","turn":"running"}')
    fireEvent.click(screen.getByRole('button', { name: 'open check' }))
    expect(screen.getByTestId('canvas').textContent).toContain('at [check]')
    fireEvent.click(screen.getByLabelText('Follow the step it is on'))
    expect(screen.getByTestId('canvas').textContent).toContain('at [turn]')
  })

  it('shows each round with its thinking open, the command it ran and what came back, and asks the person when it waits on them', async () => {
    await render(<StoryRun run={runOf(events)} events={events} />)

    const round = screen.getByTestId('story-run-round')
    expect(round.querySelector('details')!.hasAttribute('open')).toBe(true)
    expect(round.textContent).toContain('The Save button has no text, so match it by class.')
    expect(screen.getAllByTestId('story-run-call')[0]!.textContent).toContain('odoo-e2e --keep delivery_instructions e2e/delivery-slip.spec.ts')
    expect(screen.getAllByTestId('story-run-call')[0]!.textContent).toContain('· failed')
    expect(screen.getByText('What it gave back')).toBeTruthy()
    expect(screen.getByText('run_command wants to run; allow it?')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Stop/ })).toBeTruthy()
  })

  it('stops lighting a step once the run has ended', async () => {
    const ended: EngineEvent[] = [...events.slice(0, 8), { type: 'run.finished', runId: 'exec-2', at: 't9', outcome: 'ok' }]
    await render(<StoryRun run={runOf(ended)} events={ended} />)

    expect(screen.getByTestId('canvas').textContent).toContain('at [] {"claim":"done"}')
    expect(screen.queryByRole('button', { name: /Stop/ })).not.toBeInTheDocument()
    expect(screen.getByText('ok')).toBeTruthy()
  })
})
