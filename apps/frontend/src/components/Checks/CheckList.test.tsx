import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import CheckList from './CheckList'
import type { Scope } from '../../lib/check-subjects'
import type { Level2Run, Scenario, ScenarioResult } from '../../api/evals'
import { useChecksStore } from '../../stores/checks'

vi.mock('../../api/evals', async () => {
  const actual = await vi.importActual<typeof import('../../api/evals')>('../../api/evals')
  return {
    ...actual,
    listModels: vi.fn(async () => []),
    listScenarios: vi.fn(),
    listLevel2Runs: vi.fn(async () => []),
    getLevel2Run: vi.fn(),
    startLevel2Run: vi.fn(),
    cancelLevel2Run: vi.fn(async () => undefined),
    saveScenario: vi.fn(),
    deleteScenario: vi.fn(async () => undefined),
    getBench: vi.fn(async () => ({ settings: { enabled: true, idleMinutes: 15, fullEveryHours: 24 }, state: { benched: {} } })),
    listProposals: vi.fn(async () => []),
    listPractices: vi.fn(async () => []),
    listChanges: vi.fn(async () => []),
  }
})

vi.mock('../ModelSelector/ModelSelector', () => ({ default: () => <div data-testid="model-selector" /> }))
vi.mock('./ScenarioTrace', () => ({ default: () => <div data-testid="scenario-trace" /> }))

const { listScenarios, listLevel2Runs, startLevel2Run, saveScenario, deleteScenario } =
  await import('../../api/evals')

const SCENARIOS: Scenario[] = [
  {
    id: 'executor-does-one-task',
    name: 'The executor finishes a task in its sandbox',
    describe: 'It should claim the task and record it done.',
    agent: 'executor',
    procedure: { id: 'do-one-task' },
    input: { message: 'Do the task you have been given.' },
    expect: { outcome: 'ok', toolsInOrder: ['start_task', 'mark_done'] },
  },
  {
    id: 'mine-only',
    name: 'One I wrote myself',
    describe: 'Checks my own thing.',
    agent: 'executor',
    procedure: { id: 'do-one-task' },
    input: { message: 'Do my thing.' },
    expect: { outcome: 'ok' },
    mine: true,
  },
]

const result = (over: Partial<ScenarioResult> = {}): ScenarioResult => ({
  scenarioId: 'executor-does-one-task',
  name: 'The executor finishes a task in its sandbox',
  runId: 'eval2-run-1-executor-does-one-task',
  procedure: { id: 'do-one-task', version: '1' },
  passed: false,
  outcome: 'ok',
  answer: 'I wrote hello.txt.',
  checks: [
    { what: 'the run finished ok', passed: true, detail: 'it finished ok' },
    { what: 'called start_task then mark_done', passed: false, detail: 'mark_done was never called' },
  ],
  calls: [{ name: 'start_task', ok: true, digest: 'claimed write-greeting' }],
  counters: { rounds: 3, toolCalls: 1, totalTokens: 900 },
  tasks: [{ id: 'write-greeting', title: 'Write hello.txt', status: 'running' }],
  durationMs: 4200,
  ...over,
})

const run = (over: Partial<Level2Run> = {}): Level2Run => ({
  id: 'run-1',
  state: 'done',
  startedAt: '2026-09-17T09:00:00.000Z',
  scenarios: ['executor-does-one-task'],
  finished: 1,
  results: [result()],
  ...over,
})

const show = (scope: Scope = { agent: 'executor' }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <CheckList scope={scope} agents={['executor', 'koala']} procedures={['do-one-task']} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listScenarios).mockResolvedValue(SCENARIOS)
  vi.mocked(listLevel2Runs).mockResolvedValue([])
})

describe('the checks of one thing', () => {
  it('shows only the checks of what the page is about, and says when there are none', async () => {
    vi.mocked(listScenarios).mockResolvedValue([...SCENARIOS, { ...SCENARIOS[0]!, id: 'koala-chats', name: 'Koala chats', agent: 'koala', expect: { toolsCalled: ['research'] } }])
    show({ tool: 'mark_done' })
    expect(await screen.findByText('The executor finishes a task in its sandbox')).toBeInTheDocument()
    expect(screen.queryByText('One I wrote myself')).toBeNull()
    expect(screen.queryByText('Koala chats')).toBeNull()

    show({ procedure: 'never-checked' })
    expect(await screen.findByText('No check covers the never-checked procedure yet.')).toBeInTheDocument()
  })

  it('starts a new check as a check of what the page is about', async () => {
    show({ tool: 'write_file' })
    await userEvent.click(await screen.findByRole('button', { name: 'New check' }))
    expect((screen.getByPlaceholderText(/"node": "call-tool"/) as HTMLTextAreaElement).value).toContain('"tool": "write_file"')
  })

  it('lists each check with the agent and procedure it runs', async () => {
    show()

    expect(await screen.findByText('The executor finishes a task in its sandbox')).toBeInTheDocument()
    expect(screen.getAllByText('executor · do-one-task')).toHaveLength(2)
    const filters = screen.getByRole('region', { name: 'Filter checks' })
    expect(screen.getAllByText('Run').filter((badge) => !filters.contains(badge))).toHaveLength(2)
    expect(screen.getAllByText('your model').filter((badge) => !filters.contains(badge))).toHaveLength(2)
  })

  it('runs one scenario on its own', async () => {
    vi.mocked(startLevel2Run).mockResolvedValue(run({ state: 'running' }))
    show()

    await userEvent.click((await screen.findAllByRole('button', { name: 'run' }))[0]!)

    await waitFor(() => expect(startLevel2Run).toHaveBeenCalledWith({ only: ['executor-does-one-task'] }))
  })

  it('keeps each check\'s history, marks a regression, and opens any result in it with the trace behind it', async () => {
    vi.mocked(listLevel2Runs).mockResolvedValue([
      run({ regressions: ['executor-does-one-task'] }),
      run({ id: 'run-0', startedAt: '2026-09-16T09:00:00.000Z', results: [result({ passed: true, runId: 'r0' })] }),
    ])
    show()

    const history = await screen.findByRole('generic', { name: 'History of The executor finishes a task in its sandbox' })
    expect(within(history).getAllByRole('button').map((bar) => bar.getAttribute('aria-label')?.split(' ')[0])).toEqual(['passed', 'regressed'])
    await userEvent.click(within(history).getByRole('button', { name: /^regressed/ }))

    expect(screen.getByText('the run finished ok')).toBeInTheDocument()
    expect(screen.getByText('mark_done was never called')).toBeInTheDocument()
    expect(screen.getByText('I wrote hello.txt.')).toBeInTheDocument()
    expect(screen.getByTestId('scenario-trace')).toBeInTheDocument()
  })

  it('saves a scenario the person writes', async () => {
    vi.mocked(saveScenario).mockResolvedValue(SCENARIOS[1]!)
    show()

    await userEvent.click(await screen.findByRole('button', { name: 'New check' }))
    await userEvent.type(screen.getByPlaceholderText('executor-does-one-task'), 'my-scenario')
    await userEvent.type(screen.getByPlaceholderText(/The executor finishes/), 'My scenario')
    await userEvent.type(screen.getByPlaceholderText(/It should claim the task/), 'Checks a thing.')
    await userEvent.type(screen.getByPlaceholderText('Do the task you have been given.'), 'Do my thing.')
    await userEvent.selectOptions(screen.getByLabelText(/Procedure/), 'do-one-task')
    await userEvent.click(screen.getByRole('button', { name: 'Save scenario' }))

    await waitFor(() => expect(saveScenario).toHaveBeenCalledWith(expect.objectContaining({
      id: 'my-scenario',
      agent: 'executor',
      procedure: { id: 'do-one-task' },
      expect: { outcome: 'ok' },
    })))
  })

  it('says what is wrong instead of saving a scenario that cannot be read', async () => {
    show()

    await userEvent.click(await screen.findByRole('button', { name: 'New check' }))
    await userEvent.type(screen.getByPlaceholderText('executor-does-one-task'), 'Not An Id')
    await userEvent.click(screen.getByRole('button', { name: 'Save scenario' }))

    expect(await screen.findByText('the id has to be lower-case words joined by dashes')).toBeInTheDocument()
    expect(saveScenario).not.toHaveBeenCalled()
  })

  it('only offers to delete a scenario of your own', async () => {
    show()

    await screen.findByText('One I wrote myself')
    const deletes = screen.getAllByRole('button', { name: 'delete' })
    expect(deletes).toHaveLength(1)

    await userEvent.click(deletes[0]!)
    await waitFor(() => expect(deleteScenario).toHaveBeenCalledWith('mine-only'))
  })

  it('filters by level and by who plays the model', async () => {
    vi.mocked(listScenarios).mockResolvedValue([
      ...SCENARIOS,
      { ...SCENARIOS[0]!, id: 'step-write', name: 'write_file says what it wrote', procedure: { id: 'step-check-step-write' }, step: { node: 'call-tool' } },
      { ...SCENARIOS[0]!, id: 'flow-quiet', name: 'The workspace outlives its pod', script: { rules: [] }, then: [{ name: 'later', do: { waitQuiet: true } }] },
    ])
    show()
    await screen.findByText('write_file says what it wrote')

    const filters = within(screen.getByRole('region', { name: 'Filter checks' }))
    await userEvent.click(filters.getByRole('button', { name: 'Step' }))
    expect(screen.getByText('write_file says what it wrote')).toBeInTheDocument()
    expect(screen.queryByText('The workspace outlives its pod')).toBeNull()

    await userEvent.click(filters.getAllByRole('button', { name: 'All' })[0]!)
    await userEvent.click(filters.getByRole('button', { name: 'script' }))
    expect(screen.getByText('The workspace outlives its pod')).toBeInTheDocument()
    expect(screen.queryByText('write_file says what it wrote')).toBeNull()
  })

  it('leaves a check proposed for something else for that thing\'s page', async () => {
    useChecksStore.getState().propose({ ...SCENARIOS[0]!, id: 'koala-x', name: 'Koala as it ran', agent: 'koala', expect: {} })
    show()
    await screen.findByText('One I wrote myself')
    expect(screen.queryByText(/A new check from a run/)).toBeNull()
    expect(useChecksStore.getState().proposed).not.toBeNull()
    useChecksStore.getState().clearProposed()
  })

  it('opens a check proposed from a run in the editor, ready to save', async () => {
    useChecksStore.getState().propose({ ...SCENARIOS[0]!, id: 'step-decide-x', name: 'Decide as it ran at verdict', procedure: { id: 'step-check-step-decide-x' }, step: { node: 'decide', settings: { question: 'Done?' } }, expect: { exit: 'yes' } })
    show()

    expect(await screen.findByText('A new check from a run: Decide as it ran at verdict')).toBeInTheDocument()
    expect((screen.getByPlaceholderText(/"node": "call-tool"/) as HTMLTextAreaElement).value).toContain('"node": "decide"')
    expect((screen.getByPlaceholderText(/"turnLog"/) as HTMLTextAreaElement).value).toContain('"exit": "yes"')
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(useChecksStore.getState().proposed).toBeNull()
  })
})
