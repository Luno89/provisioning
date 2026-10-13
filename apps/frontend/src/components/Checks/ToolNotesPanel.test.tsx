import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ToolNotesPanel from './ToolNotesPanel'
import type { NoteScope } from './tool-notes'

vi.mock('../../api/evals', async () => {
  const actual = await vi.importActual<typeof import('../../api/evals')>('../../api/evals')
  return { ...actual, listToolNotes: vi.fn(), makeToolNoteLive: vi.fn(async () => undefined), retireToolNote: vi.fn(async () => undefined) }
})

const { listToolNotes, makeToolNoteLive, retireToolNote } = await import('../../api/evals')

const show = (scope: NoteScope) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><ToolNotesPanel scope={scope} /></QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listToolNotes).mockResolvedValue([
    { id: 'held', tool: 'start_task', status: 'pending_review', model: 'qwen/q', title: 'Claim first', text: 'It claims the task.', why: 'runs r1 and r2', trial: { checkedAt: 'a', runId: 'b1', scenarios: ['x'], regressions: ['x'] }, createdAt: 'a', updatedAt: 'a' },
    { id: 'live', tool: 'start_task', status: 'active', title: 'Live one', text: 'Live text.', trial: { checkedAt: 'a', scenarios: ['x', 'y'], regressions: [], better: ['y'] }, createdAt: 'a', updatedAt: 'a' },
    { id: 'click', server: 'playwright', tool: 'browser_click', status: 'trial', title: 'Click by ref', text: 'Use the ref.', createdAt: 'a', updatedAt: 'a' },
  ])
})

describe('notes learned about a tool', () => {
  it('shows the tool\'s own notes by where they stand, with what they were learned from and how their trial went', async () => {
    show({ tool: 'start_task' })
    expect(await screen.findByText('Held for you (1)')).toBeInTheDocument()
    expect(screen.getByText('on start_task, only for qwen/q')).toBeInTheDocument()
    expect(screen.getByText('Learned from: runs r1 and r2')).toBeInTheDocument()
    expect(screen.getByText('Trial: regressed x in bench run b1')).toBeInTheDocument()
    expect(screen.getByText('Trial: nothing regressed across 2 checks, and y now passes')).toBeInTheDocument()
    expect(screen.queryByText('Click by ref')).not.toBeInTheDocument()
  })

  it('lets the person make a held note live, and retire one', async () => {
    show({ tool: 'start_task' })
    await userEvent.click(await screen.findByRole('button', { name: 'Make live' }))
    await waitFor(() => expect(makeToolNoteLive).toHaveBeenCalledWith('held'))
    await userEvent.click(screen.getAllByRole('button', { name: 'Retire' })[1]!)
    await waitFor(() => expect(retireToolNote).toHaveBeenCalledWith('live'))
  })

  it('shows a server\'s notes with those on each of its tools, and says when nothing was learned', async () => {
    show({ server: 'playwright' })
    expect(await screen.findByText('on browser_click')).toBeInTheDocument()
    show({ server: 'gitea' })
    expect(await screen.findByText('Nothing learned yet.')).toBeInTheDocument()
  })
})
