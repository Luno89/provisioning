import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ProcedureExplorer from './ProcedureExplorer'

const navigate = vi.fn(async () => undefined)
const params = vi.hoisted(() => ({ procedureId: undefined as string | undefined, part: undefined as string | undefined }))
const seen = vi.hoisted(() => ({ props: {} as Record<string, Record<string, unknown>> }))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useParams: () => params,
  Link: ({ children, to, params: linked }: { children: React.ReactNode; to: string; params?: Record<string, string> }) =>
    <a href={Object.entries(linked ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to)}>{children}</a>,
}))

const { stub } = vi.hoisted(() => ({
  stub: (name: string) => ({ default: (props: Record<string, unknown>) => { seen.props[name] = props; return <div data-testid={name} /> } }),
}))
vi.mock('./ProcedureEditor', () => stub('editor'))
vi.mock('../Checks/CheckList', () => stub('checks'))
vi.mock('../Checks/shared', () => ({ useScenarios: () => ({ data: [] }), useLevel2Runs: () => ({ data: [] }) }))

vi.mock('../../api/agents', async () => {
  const actual = await vi.importActual<typeof import('../../api/agents')>('../../api/agents')
  return {
    ...actual,
    listAgents: vi.fn(async () => [
      { slug: 'koala', procedure: 'interactive-chat', usedBy: [{ kind: 'chat', by: 'every new conversation' }] },
      { slug: 'research', procedure: 'research', usedBy: [{ kind: 'hand-off', by: 'koala' }] },
    ]),
  }
})

vi.mock('../../api/procedures', async () => {
  const actual = await vi.importActual<typeof import('../../api/procedures')>('../../api/procedures')
  return {
    ...actual,
    listProcedures: vi.fn(async () => ({
      procedures: [
        { id: 'interactive-chat', version: '3', name: 'Interactive chat', describe: 'One turn', mine: false, ofBuiltIn: true, requires: [] },
        { id: 'research', version: '3', name: 'Research', describe: 'Looks things up', mine: true, ofBuiltIn: true, requires: [{ name: 'write_file', kind: 'tool', node: 'w', why: 'It writes its findings.' }] },
        { id: 'triage', version: '1', name: 'Triage', describe: '', mine: true, ofBuiltIn: false, requires: [] },
      ],
      unreadable: [{ id: 'broken', report: 'node "x" is not a kind of node' }],
    })),
    saveProcedure: vi.fn(async (procedure) => ({ saved: true, procedure: { ...procedure, version: '1' }, problems: [] })),
    deleteProcedure: vi.fn(async () => undefined),
  }
})

const api = await import('../../api/procedures')

const show = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ProcedureExplorer />
  </QueryClientProvider>,
)

const tree = () => within(screen.getByRole('complementary', { name: 'Procedures' }))

beforeEach(() => {
  vi.clearAllMocks()
  seen.props = {}
  params.procedureId = undefined
  params.part = undefined
})

describe('the procedures explorer', () => {
  it('groups procedures by the agents that run them', async () => {
    show()
    expect(await tree().findByText('Run by agents you talk to')).toBeInTheDocument()
    expect(tree().getByText('Run by agents handed work')).toBeInTheDocument()
    expect(tree().getByText('Not run by any agent')).toBeInTheDocument()
    expect(tree().getByText('Interactive chat').closest('a')).toHaveAttribute('href', '/studio/procedures/interactive-chat')
  })

  it('opens a procedure on who runs it and what it needs', async () => {
    params.procedureId = 'research'
    show()
    expect(await screen.findByText('your copy of a built-in')).toBeInTheDocument()
    expect(screen.getByText('research', { selector: 'a' })).toHaveAttribute('href', '/studio/agents/research')
    expect(screen.getByText('— It writes its findings.')).toBeInTheDocument()
  })

  it('opens its steps in the canvas, filling the pane', async () => {
    params.procedureId = 'interactive-chat'
    params.part = 'steps'
    show()
    await waitFor(() => expect(seen.props.editor).toMatchObject({ procedureId: 'interactive-chat' }))
  })

  it('opens its checks scoped to it', async () => {
    params.procedureId = 'triage'
    params.part = 'checks'
    show()
    await waitFor(() => expect(seen.props.checks).toMatchObject({ scope: { procedure: 'triage' } }))
  })

  it('creates a new procedure that already checks clean and opens its steps', async () => {
    show()
    await tree().findByText('Research')
    await userEvent.click(screen.getByRole('button', { name: 'New procedure' }))
    await userEvent.type(screen.getByLabelText('Name of the new procedure'), 'Bug Triage{Enter}')

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/studio/procedures/$procedureId/$part', params: { procedureId: 'bug-triage', part: 'steps' } }))
    expect(vi.mocked(api.saveProcedure).mock.calls[0]![0]).toMatchObject({ id: 'bug-triage', name: 'Bug Triage', start: 'finish' })
  })

  it('refuses a name whose id is already taken', async () => {
    show()
    await tree().findByText('Research')
    await userEvent.click(screen.getByRole('button', { name: 'New procedure' }))
    await userEvent.type(screen.getByLabelText('Name of the new procedure'), 'Triage{Enter}')

    expect(await screen.findByText('"triage" is already taken')).toBeInTheDocument()
    expect(api.saveProcedure).not.toHaveBeenCalled()
  })

  it('says why a saved procedure cannot be read, and lets you throw it away', async () => {
    show()
    expect(await screen.findByText('broken')).toBeInTheDocument()
    expect(screen.getByText('node "x" is not a kind of node')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Delete it' }))
    await waitFor(() => expect(vi.mocked(api.deleteProcedure).mock.calls[0]?.[0]).toBe('broken'))
  })
})
