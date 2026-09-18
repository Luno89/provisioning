import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Level1Panel from './Level1Panel'
import type { EvalCase, Level1Run } from '../../api/evals'

vi.mock('../../api/evals', async () => {
  const actual = await vi.importActual<typeof import('../../api/evals')>('../../api/evals')
  return {
    ...actual,
    listCases: vi.fn(),
    listModels: vi.fn(async () => []),
    listLevel1Runs: vi.fn(async () => []),
    getLevel1Run: vi.fn(),
    startLevel1Run: vi.fn(),
    cancelLevel1Run: vi.fn(async () => undefined),
    saveCase: vi.fn(),
    deleteCase: vi.fn(async () => undefined),
    getPrompt: vi.fn(async () => 'You build procedures.'),
  }
})

vi.mock('../ModelSelector/ModelSelector', () => ({
  default: () => <div data-testid="model-selector" />,
}))

const {
  listCases, listLevel1Runs, getLevel1Run, startLevel1Run, saveCase, deleteCase,
} = await import('../../api/evals')

const CASES: EvalCase[] = [
  {
    name: 'read/by-name',
    category: 'simple',
    agent: 'agent-builder',
    say: 'Show me the research procedure.',
    expect: { tool: 'read_procedure' },
  },
  {
    name: 'chat/answers-plainly',
    category: 'irrelevance',
    agent: 'koala',
    say: 'What is a procedure?',
    expect: { tool: null },
    mine: true,
  },
]

const run = (over: Partial<Level1Run> = {}): Level1Run => ({
  id: 'run-1',
  state: 'done',
  startedAt: '2026-09-17T09:00:00.000Z',
  repeats: 3,
  toolCatalogueHash: 'hash',
  cases: ['read/by-name'],
  finished: 1,
  results: [{
    name: 'read/by-name',
    category: 'simple',
    agent: 'agent-builder',
    expects: 'read_procedure',
    attempts: [
      {
        attempt: 0, passed: true, toolsOffered: ['read_procedure'], content: '', thinking: '',
        toolCalls: [{ name: 'read_procedure', arguments: '{"procedure":"research"}' }],
        promptTokens: 10, completionTokens: 5, totalTokens: 15, latencyMs: 300, systemHash: 'abcdef1234',
      },
      {
        attempt: 1, passed: false, complaint: 'called nothing', toolsOffered: ['read_procedure'],
        content: 'I think it reads it.', thinking: '', toolCalls: [],
        promptTokens: 10, completionTokens: 5, totalTokens: 15, latencyMs: 250,
      },
    ],
  }],
  summary: {
    reliability: { cases: 1, always: 0, never: 0, flaky: 1 },
    tools: [{ tool: 'read_procedure', cases: 1, attempts: 2, passed: 1, complaints: ['called nothing'] }],
  },
  ...over,
})

const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Level1Panel />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listCases).mockResolvedValue({ cases: CASES, coverage: [] })
  vi.mocked(listLevel1Runs).mockResolvedValue([])
})

describe('the level 1 panel', () => {
  it('lists every case under the persona that runs it', async () => {
    show()

    expect(await screen.findByText('read/by-name')).toBeInTheDocument()
    expect(screen.getByText('agent-builder')).toBeInTheDocument()
    expect(screen.getByText('koala')).toBeInTheDocument()
    expect(screen.getByText('read_procedure')).toBeInTheDocument()
  })

  it('starts a run of only the cases still ticked', async () => {
    vi.mocked(startLevel1Run).mockResolvedValue(run({ state: 'running' }))
    show()

    await userEvent.click(await screen.findByLabelText('Include chat/answers-plainly'))
    await userEvent.click(screen.getByRole('button', { name: /Run 1 case/ }))

    await waitFor(() => expect(startLevel1Run).toHaveBeenCalledWith(expect.objectContaining({
      only: ['read/by-name'],
      repeats: 5,
    })))
  })

  it('shows how each attempt went, and the prompt behind it, when a case is opened', async () => {
    vi.mocked(listLevel1Runs).mockResolvedValue([run()])
    vi.mocked(getLevel1Run).mockResolvedValue(run())
    show()

    await userEvent.click((await screen.findAllByRole('button', { name: 'open' }))[0]!)

    expect(await screen.findByText(/attempt 1 passed/)).toBeInTheDocument()
    expect(screen.getByText(/attempt 2 failed/)).toBeInTheDocument()
    expect(screen.getAllByText('called nothing').length).toBeGreaterThan(0)

    await userEvent.click(screen.getByRole('button', { name: /prompt abcdef12/ }))
    expect(await screen.findByText('You build procedures.')).toBeInTheDocument()
  })

  it('saves a case the person writes', async () => {
    vi.mocked(saveCase).mockResolvedValue({ ...CASES[0]!, name: 'read/again' })
    show()

    await userEvent.click(await screen.findByRole('button', { name: 'New case' }))
    await userEvent.type(screen.getByPlaceholderText('read/by-name'), 'read/again')
    await userEvent.type(screen.getByPlaceholderText('read_procedure'), 'read_procedure')
    await userEvent.type(screen.getByPlaceholderText(/procedure is research/), 'procedure is research')
    await userEvent.click(screen.getByRole('button', { name: 'Save case' }))

    await waitFor(() => expect(saveCase).toHaveBeenCalledWith(expect.objectContaining({
      name: 'read/again',
      expect: { tool: 'read_procedure', args: [{ arg: 'procedure', is: 'research' }] },
    })))
  })

  it('refuses to save an argument check it cannot read, without calling the server', async () => {
    show()

    await userEvent.click(await screen.findByRole('button', { name: 'New case' }))
    await userEvent.type(screen.getByPlaceholderText('read/by-name'), 'read/again')
    await userEvent.type(screen.getByPlaceholderText(/procedure is research/), 'procedure')
    await userEvent.click(screen.getByRole('button', { name: 'Save case' }))

    expect(await screen.findByText(/has to read like/)).toBeInTheDocument()
    expect(saveCase).not.toHaveBeenCalled()
  })

  it('only offers to delete a case of your own', async () => {
    vi.mocked(listLevel1Runs).mockResolvedValue([])
    show()

    const opens = await screen.findAllByRole('button', { name: 'open' })
    await userEvent.click(opens[0]!)
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()

    await userEvent.click((await screen.findAllByRole('button', { name: 'open' }))[1]!)
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(deleteCase).toHaveBeenCalledWith('chat/answers-plainly'))
  })
})
