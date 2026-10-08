import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import TaskBoard from './TaskBoard'
import type { EngineTask } from '../../api/engine'

vi.mock('../../api/engine', async () => {
  const actual = await vi.importActual<typeof import('../../api/engine')>('../../api/engine')
  return {
    ...actual,
    listTasks: vi.fn(),
    acceptTask: vi.fn(async () => undefined),
    dropTask: vi.fn(async () => undefined),
  }
})

const { listTasks, acceptTask, dropTask } = await import('../../api/engine')

const task = (over: Partial<EngineTask> & Pick<EngineTask, 'id'>): EngineTask => ({
  title: over.id,
  doneMeans: 'it works',
  status: 'proposed',
  dependsOn: [],
  ready: true,
  waitingOn: [],
  ...over,
})

const show = (tasks: EngineTask[]) => {
  vi.mocked(listTasks).mockResolvedValue(tasks)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TaskBoard />
    </QueryClientProvider>,
  )
}

beforeEach(() => { vi.clearAllMocks() })

describe('TaskBoard', () => {
  it('takes no room on the page when there are no tasks', async () => {
    const { container } = show([])
    await waitFor(() => expect(listTasks).toHaveBeenCalled())
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('keeps finished tasks folded away until asked', async () => {
    show([task({ id: 'open', title: 'Open one', status: 'running' }), task({ id: 'gone', title: 'Done one', status: 'done' }), task({ id: 'dropped', title: 'Dropped one', status: 'dropped' })])

    expect(await screen.findByText('Open one')).toBeInTheDocument()
    expect(screen.queryByText('Done one')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Show 2 finished' }))
    expect(screen.getByText('Done one')).toBeInTheDocument()
    expect(screen.getByText('Dropped one')).toBeInTheDocument()
  })

  it('shows what a task is and how it will be judged', async () => {
    show([task({ id: 't1', title: 'Fix the database host', doneMeans: 'the pod stops crash-looping' })])

    await userEvent.click(await screen.findByText('Fix the database host'))
    expect(screen.getByText(/the pod stops crash-looping/)).toBeInTheDocument()
  })

  it('flags how much is waiting on you', async () => {
    show([task({ id: 't1' }), task({ id: 't2' }), task({ id: 't3', status: 'done' })])

    expect(await screen.findByText('2 waiting on you')).toBeInTheDocument()
  })

  it('offers accept and drop only on proposed work', async () => {
    show([task({ id: 't1', status: 'proposed' }), task({ id: 't2', status: 'running' })])

    await screen.findByText('t1')
    expect(screen.getAllByRole('button', { name: /Accept/ })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /Drop/ })).toHaveLength(1)
  })

  it('accepts work when you say so', async () => {
    show([task({ id: 't1' })])
    await screen.findByText('t1')

    await userEvent.click(screen.getByRole('button', { name: /Accept/ }))

    await waitFor(() => expect(vi.mocked(acceptTask).mock.calls[0]?.[0]).toBe('t1'))
  })

  it('drops work when you say so', async () => {
    show([task({ id: 't1' })])
    await screen.findByText('t1')

    await userEvent.click(screen.getByRole('button', { name: /Drop/ }))

    await waitFor(() => expect(vi.mocked(dropTask).mock.calls[0]?.[0]).toBe('t1'))
  })

  it('says what a blocked task is waiting on', async () => {
    show([task({
      id: 't2',
      status: 'accepted',
      ready: false,
      waitingOn: [{ id: 't1', title: 'Groundwork', status: 'running' }],
    })])

    expect(await screen.findByText(/waiting on Groundwork/)).toBeInTheDocument()
  })

  it('shows the check a task will be held to', async () => {
    show([task({ id: 't1', checks: { command: 'npm test' } })])

    await userEvent.click(await screen.findByText('t1'))
    expect(screen.getByText(/checked by: npm test/)).toBeInTheDocument()
  })

  it('shows the evidence a finished task left behind', async () => {
    show([task({ id: 't1', status: 'done', evidence: 'tests pass, pod healthy' })])

    await userEvent.click(await screen.findByRole('button', { name: 'Show 1 finished' }))
    await userEvent.click(screen.getByText('t1'))
    expect(screen.getByText(/tests pass, pod healthy/)).toBeInTheDocument()
  })

  it('puts what needs you first, and finished work last', async () => {
    show([
      task({ id: 'finished', title: 'Finished', status: 'done' }),
      task({ id: 'needs-you', title: 'Needs you', status: 'proposed' }),
    ])

    await userEvent.click(await screen.findByRole('button', { name: 'Show 1 finished' }))
    const rendered = screen.getAllByRole('listitem').map((item) => item.textContent ?? '')

    expect(rendered[0]).toContain('Needs you')
    expect(rendered.at(-1)).toContain('Finished')
  })
})
