import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RESEARCH_V2, type Procedure } from '@koala/agent-engine/procedure'
import { starterProcedure } from '../../lib/procedure-drafts'
import ProcedureEditor from './ProcedureEditor'

const navigate = vi.fn(async () => undefined)

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}))

vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange, language }: { value?: string; onChange?: (value: string) => void; language?: string }) => (
    <textarea aria-label={language === 'typescript' ? 'procedure code' : 'procedure json'} value={value ?? ''} onChange={(event) => onChange?.(event.target.value)} />
  ),
}))

vi.mock('../ProjectEditor/monaco-setup', () => ({}))

vi.mock('../../api/procedures', async () => {
  const actual = await vi.importActual<typeof import('../../api/procedures')>('../../api/procedures')
  return {
    ...actual,
    getProcedure: vi.fn(),
    listProcedures: vi.fn(async () => ({ procedures: [], unreadable: [] })),
    checkProcedureOnServer: vi.fn(async () => []),
    getTrackRecords: vi.fn(async () => [{
      modelKey: 'tabby', modelLabel: 'Tabbyapi-Production', runs: 3, successes: 2,
      typical: { rounds: 4, toolCalls: 6, totalTokens: 12_000, childRuns: 0, wallClockMs: 90_000 }, limits: undefined,
    }]),
    saveProcedure: vi.fn(),
    deleteProcedure: vi.fn(async () => undefined),
  }
})

vi.mock('../../api/engine', async () => {
  const actual = await vi.importActual<typeof import('../../api/engine')>('../../api/engine')
  return {
    ...actual,
    listEngineAgents: vi.fn(async () => [{ slug: 'research', name: 'Research', description: '', loop: 'research', tools: [], canDelegateTo: [], inputs: null, mine: false }]),
    startRun: vi.fn(async () => ({ runId: 'run-1', agentSlug: 'research', loopId: 'research' })),
  }
})

vi.mock('../ModelSelector/ModelSelector', () => ({ default: () => <div>model</div> }))

const api = await import('../../api/procedures')
const engine = await import('../../api/engine')

const open = (procedure: Procedure, mine = true) => {
  vi.mocked(api.getProcedure).mockResolvedValue({ procedure, mine })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <div style={{ width: 1400, height: 900 }}>
        <ProcedureEditor procedureId={procedure.id} />
      </div>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.saveProcedure).mockImplementation(async (procedure) => ({ saved: true, procedure: { ...procedure, version: '2' }, problems: [] }))
})

describe('the procedure editor', () => {
  it('adds a node from the list, selects it, and shows its settings', async () => {
    open(starterProcedure('fresh', 'Fresh'))
    await userEvent.click(await screen.findByTitle(/^A piece of text you write/))

    expect(await screen.findByRole('heading', { name: 'Text' })).toBeInTheDocument()
    expect(screen.getByText(/unsaved changes/)).toBeInTheDocument()
  })

  it('saves the draft, shows the new version, and no longer counts it as changed', async () => {
    open(starterProcedure('fresh', 'Fresh'))
    await userEvent.click(await screen.findByTitle(/^A piece of text you write/))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Saved as version 2')
    expect(vi.mocked(api.saveProcedure).mock.calls[0]![0].nodes.map((node) => node.kind)).toEqual(['finish', 'text'])
    expect(screen.queryByText(/unsaved changes/)).not.toBeInTheDocument()
  })

  it('undoes and redoes a change', async () => {
    open(starterProcedure('fresh', 'Fresh'))
    await userEvent.click(await screen.findByTitle(/^A piece of text you write/))
    await userEvent.click(screen.getByTitle('Undo (Ctrl+Z)'))

    expect(screen.queryByText(/unsaved changes/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByTitle('Redo (Ctrl+Shift+Z)'))
    expect(screen.getByText(/unsaved changes/)).toBeInTheDocument()
  })

  it('will not save a procedure with errors, and says why', async () => {
    open({ ...starterProcedure('fresh', 'Fresh'), start: 'missing' })
    await userEvent.click(await screen.findByTitle(/^A piece of text you write/))

    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    expect(save).toHaveAttribute('title', 'Fix the errors in Problems first')
    await userEvent.click(screen.getByRole('button', { name: /Problems/ }))
    expect(await screen.findByText('the start node "missing" does not exist')).toBeInTheDocument()
  })

  it('offers to save a built-in as your own copy straight away', async () => {
    open(RESEARCH_V2, false)

    expect(await screen.findByText('Built-in: saving makes it your own copy')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('applies JSON edits to the procedure, but keeps its id', async () => {
    open(starterProcedure('fresh', 'Fresh'))
    await userEvent.click(await screen.findByRole('button', { name: 'JSON' }))
    const json = await screen.findByLabelText('procedure json') as HTMLTextAreaElement

    fireEvent.change(json, { target: { value: json.value.replace('"name": "Fresh"', '"name": "Renamed"') } })
    expect(await screen.findByRole('heading', { name: 'Renamed' })).toBeInTheDocument()

    fireEvent.change(json, { target: { value: json.value.replace('"id": "fresh"', '"id": "other"') } })
    expect(screen.getByText(/the id stays "fresh" here/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Renamed' })).toBeInTheDocument()
  })

  it('opens a built-in group to show what is inside, without letting it be changed', async () => {
    open(RESEARCH_V2, false)
    await screen.findByTitle(/^Sends the system prompt/)
    fireEvent.doubleClick(within(document.querySelector('.react-flow') as HTMLElement).getByText('Model Turn'))

    const trail = screen.getByRole('navigation', { name: 'Where you are' })
    expect(trail).toHaveTextContent('Model Turn')
    expect(trail).toHaveTextContent('built-in group · view only')
    expect(screen.getByTitle(/^Sends the system prompt/)).toBeDisabled()
  })

  it('runs the saved procedure under the chosen agent, and refuses while there are unsaved changes', async () => {
    open(RESEARCH_V2, true)
    await userEvent.click(await screen.findByRole('button', { name: 'Run' }))
    await userEvent.type(screen.getByLabelText('Run message'), 'what is new?{Enter}')

    await waitFor(() => expect(engine.startRun).toHaveBeenCalledWith({ agent: 'research', message: 'what is new?', inputs: { message: 'what is new?' }, procedure: 'research' }))

    await userEvent.click(screen.getByRole('button', { name: /^Procedures/ }).closest('header')!.querySelector('button[title="Lay the nodes out left to right in the order they run"]')!)
    expect(await screen.findByText('Save your changes first — a run uses the saved version.')).toBeInTheDocument()
  })
  it("shows how long runs usually take on each model instead of a fixed budget", async () => {
    open(starterProcedure('fresh', 'Fresh'))

    expect(await screen.findByText('Tabbyapi-Production')).toBeInTheDocument()
    expect(screen.getByText('2 of 3 succeeded')).toBeInTheDocument()
    expect(screen.getByText('4 rounds')).toBeInTheDocument()
    expect(screen.getByText('1.5 min')).toBeInTheDocument()
    expect(screen.getByText('3 more successful runs before limits apply.')).toBeInTheDocument()
    expect(screen.queryByText('0 child runs')).not.toBeInTheDocument()
  })
  it('shows the procedure as builder code, applies edits to it, and points at code that does not read', async () => {
    open(starterProcedure('fresh', 'Fresh'))
    await userEvent.click(await screen.findByRole('button', { name: 'Code' }))
    const code = await screen.findByLabelText('procedure code') as HTMLTextAreaElement

    expect(code.value).toContain("const finish = p.finish('finish', {}, { outcome: 'ok' })")

    fireEvent.change(code, { target: { value: code.value.replace("{ outcome: 'ok' }", "{ outcome: 'failed', reason: 'written in code' }") } })
    expect(await screen.findByText(/unsaved changes/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Canvas' }))
    expect(await screen.findByText(/finishes failed: written in code/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Code' }))
    const again = await screen.findByLabelText('procedure code') as HTMLTextAreaElement
    fireEvent.change(again, { target: { value: again.value.replace("p.start(finish)", "p.start(finish)\n  finish.on('done', finish)") } })
    expect(screen.getByText(/Not applied yet — line \d+, column \d+: Finish "finish" has no exit called "done"/)).toBeInTheDocument()
  })
})
