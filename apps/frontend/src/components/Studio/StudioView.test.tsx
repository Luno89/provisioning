import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import StudioView from './StudioView'

const navigate = vi.fn(async () => undefined)

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}))

vi.mock('../../api/procedures', async () => {
  const actual = await vi.importActual<typeof import('../../api/procedures')>('../../api/procedures')
  return {
    ...actual,
    listProcedures: vi.fn(async () => ({
      procedures: [
        { id: 'research', version: '3', name: 'Research', describe: 'Looks things up', mine: true },
        { id: 'tool-rounds', version: '2', name: 'Tool rounds', describe: '', mine: false },
        { id: 'triage', version: '1', name: 'Triage', describe: 'Sorts issues', mine: true },
      ],
      unreadable: [{ id: 'broken', report: 'node "x" is not a kind of node' }],
    })),
    saveProcedure: vi.fn(async (procedure) => ({ saved: true, procedure: { ...procedure, version: '1' }, problems: [] })),
  }
})

const api = await import('../../api/procedures')

const show = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <StudioView />
  </QueryClientProvider>,
)

beforeEach(() => { vi.clearAllMocks() })

describe('the procedure list', () => {
  it('says whose each procedure is, and shows the ones that could not be read', async () => {
    show()

    expect(await screen.findByText('your copy of a built-in')).toBeInTheDocument()
    expect(screen.getByText('built-in')).toBeInTheDocument()
    expect(screen.getByText('yours')).toBeInTheDocument()
    expect(screen.getByText('No description yet.')).toBeInTheDocument()
    expect(screen.getByText('node "x" is not a kind of node')).toBeInTheDocument()
  })

  it('creates a new procedure that already checks clean and opens it', async () => {
    show()
    await screen.findByText('Research')
    await userEvent.click(screen.getByRole('button', { name: 'New procedure' }))
    await userEvent.type(screen.getByLabelText('Name of the new procedure'), 'Bug Triage{Enter}')

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/studio/$procedureId', params: { procedureId: 'bug-triage' } }))
    expect(vi.mocked(api.saveProcedure).mock.calls[0]![0]).toMatchObject({ id: 'bug-triage', name: 'Bug Triage', start: 'finish' })
  })

  it('refuses a name whose id is already taken', async () => {
    show()
    await screen.findByText('Research')
    await userEvent.click(screen.getByRole('button', { name: 'New procedure' }))
    await userEvent.type(screen.getByLabelText('Name of the new procedure'), 'Triage')

    expect(screen.getByText('"triage" is already taken')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
  })
})
