import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as engineApi from '../../../engine/api/engine'
import { StoryTasks } from './StoryTasks'
import { localWorkSource, WorkSourceContext } from '../../lib/work-source'

vi.mock('../../../engine/api/engine', async (orig) => ({ ...(await orig<typeof engineApi>()), acceptTask: vi.fn(async () => undefined), dropTask: vi.fn(async () => undefined) }))

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

  it('on a shared project, says an acceptance waits for the owner\'s instance while it is offline, in place of deciding again', () => {
    const hub = {
      projectId: 'shared', online: false, people: new Map<string, string>(), ownerEmail: 'owner@koala.test',
      requests: [{ id: 'r1', kind: 'accept-task' as const, input: { taskId: 'p' }, by: { personId: 'me', email: 'me@koala.test', role: 'collaborator' as const }, at: 't', state: 'waiting' as const }],
    }
    render(<QueryClientProvider client={new QueryClient()}><WorkSourceContext.Provider value={{ ...localWorkSource, key: ['hub', 'shared'], hub }}><StoryTasks tasks={[task('p', 'proposed'), task('q', 'proposed')]} /></WorkSourceContext.Provider></QueryClientProvider>)
    expect(screen.getByTestId('task-waiting')).toHaveTextContent('The acceptance waits for owner@koala.test\'s instance, which is offline; it is carried out when it is back.')
    expect(screen.queryByRole('button', { name: 'Accept “Task p”' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Accept “Task q”' })).toBeInTheDocument()
  })

  it('shows nothing for a story with no tasks', () => {
    const { container } = render(<QueryClientProvider client={new QueryClient()}><StoryTasks tasks={[]} /></QueryClientProvider>)
    expect(container).toBeEmptyDOMElement()
  })
})
