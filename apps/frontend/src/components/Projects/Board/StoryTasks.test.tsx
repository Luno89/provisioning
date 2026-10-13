import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as engineApi from '../../../api/engine'
import { StoryTasks } from './StoryTasks'

vi.mock('../../../api/engine', async (orig) => ({ ...(await orig<typeof engineApi>()), acceptTask: vi.fn(async () => undefined), dropTask: vi.fn(async () => undefined) }))

const task = (id: string, status: engineApi.TaskStatus): engineApi.EngineTask => ({ id, leafId: 'l1', title: `Task ${id}`, doneMeans: `${id} works`, status, dependsOn: [], ready: true, waitingOn: [] })

describe('a story\'s tasks on its page', () => {
  it('lists its tasks with their state, puts the proposed ones first to accept or drop, and the dropped ones last', async () => {
    render(<QueryClientProvider client={new QueryClient()}><StoryTasks tasks={[task('a', 'done'), task('b', 'running'), task('p', 'proposed'), task('q', 'proposed'), task('x', 'dropped')]} /></QueryClientProvider>)
    const section = screen.getByRole('region', { name: 'Tasks' })
    expect(section).toHaveTextContent('Proposed while it was worked')
    expect(section).toHaveTextContent('doneTask a')
    expect(section).toHaveTextContent('1 dropped: Task x')
    fireEvent.click(screen.getByRole('button', { name: 'Accept “Task p”' }))
    await waitFor(() => expect(engineApi.acceptTask).toHaveBeenCalledWith('p', expect.anything()))
    fireEvent.click(screen.getByRole('button', { name: 'Drop “Task q”' }))
    await waitFor(() => expect(engineApi.dropTask).toHaveBeenCalledWith('q', expect.anything()))
  })

  it('shows nothing for a story with no tasks', () => {
    const { container } = render(<QueryClientProvider client={new QueryClient()}><StoryTasks tasks={[]} /></QueryClientProvider>)
    expect(container).toBeEmptyDOMElement()
  })
})
