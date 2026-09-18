import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Level2Panel from './Level2Panel'
import type { Level2Run, Scenario, ScenarioResult } from '../../api/evals'

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
  }
})

vi.mock('../ModelSelector/ModelSelector', () => ({ default: () => <div data-testid="model-selector" /> }))
vi.mock('./ScenarioTrace', () => ({ default: () => <div data-testid="scenario-trace" /> }))
vi.mock('../Studio/shared', () => ({
  useProcedureList: () => ({ data: { procedures: [{ id: 'do-one-task', name: 'Do one task' }], unreadable: [] } }),
}))

const { listScenarios, listLevel2Runs, getLevel2Run, startLevel2Run, saveScenario, deleteScenario } =
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

const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Level2Panel />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listScenarios).mockResolvedValue(SCENARIOS)
  vi.mocked(listLevel2Runs).mockResolvedValue([])
})

describe('the level 2 panel', () => {
  it('lists each scenario with the persona and procedure it runs', async () => {
    show()

    expect(await screen.findByText('The executor finishes a task in its sandbox')).toBeInTheDocument()
    expect(screen.getAllByText('executor · do-one-task')).toHaveLength(2)
  })

  it('runs one scenario on its own', async () => {
    vi.mocked(startLevel2Run).mockResolvedValue(run({ state: 'running' }))
    show()

    await userEvent.click((await screen.findAllByRole('button', { name: 'run' }))[0]!)

    await waitFor(() => expect(startLevel2Run).toHaveBeenCalledWith({ only: ['executor-does-one-task'] }))
  })

  it('shows every check of a result, passed and failed, with the trace behind it', async () => {
    vi.mocked(listLevel2Runs).mockResolvedValue([run()])
    vi.mocked(getLevel2Run).mockResolvedValue(run())
    show()

    await userEvent.click(await screen.findByRole('button', { name: /1\/2 checks/ }))

    expect(screen.getByText('the run finished ok')).toBeInTheDocument()
    expect(screen.getByText('mark_done was never called')).toBeInTheDocument()
    expect(screen.getByText('I wrote hello.txt.')).toBeInTheDocument()
    expect(screen.getByTestId('scenario-trace')).toBeInTheDocument()
  })

  it('saves a scenario the person writes', async () => {
    vi.mocked(saveScenario).mockResolvedValue(SCENARIOS[1]!)
    show()

    await userEvent.click(await screen.findByRole('button', { name: 'New scenario' }))
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

    await userEvent.click(await screen.findByRole('button', { name: 'New scenario' }))
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
})
