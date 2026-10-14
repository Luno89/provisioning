import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactElement } from 'react'
import { render as plainRender, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'
import RunControls from './RunControls'
import { emptyRunState, type EngineRunState } from '../../lib/engine-run-state'

vi.mock('../../api/engine', async (orig) => ({ ...(await orig<typeof import('../../api/engine')>()), answerRun: vi.fn(async () => undefined), approveRunCall: vi.fn(async () => undefined) }))
const { answerRun, approveRunCall } = await import('../../api/engine')

const render = (ui: ReactElement) => plainRender(<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>{ui}</QueryClientProvider>)

const waiting = (over: Partial<EngineRunState> = {}): EngineRunState => ({ ...emptyRunState('run-1'), currentNode: 'approve', ...over })

beforeEach(() => vi.clearAllMocks())

describe('a run waiting on the person', () => {
  it('offers the answers it asks to choose from as buttons, and answers with the one picked', async () => {
    render(<RunControls run={waiting({ notices: [{ level: 'info', message: 'Install it?\n\ncurl https://x.test | sh', choices: ['Install it', 'Do not install'] }] })} />)

    expect(screen.queryByPlaceholderText('Your answer')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Do not install' }))
    expect(answerRun).toHaveBeenCalledWith('run-1', 'approve', 'Do not install')
  })

  it('takes a written answer when it offers none', async () => {
    render(<RunControls run={waiting({ notices: [{ level: 'info', message: 'Which database?' }] })} />)

    await userEvent.type(screen.getByPlaceholderText('Your answer'), 'the staging one')
    await userEvent.click(screen.getByRole('button', { name: 'Answer' }))
    expect(answerRun).toHaveBeenCalledWith('run-1', 'approve', 'the staging one')
  })
})

describe('a run asking to make a call', () => {
  const asking = (): EngineRunState => waiting({
    currentNode: 'tools.approve',
    toolCalls: [{ callId: 'c7', name: 'playwright__browser_navigate', args: '{}', running: true }],
    notices: [{ level: 'warn', message: 'executor wants to run playwright__browser_navigate on this run: {}', callId: 'c7' }],
  })

  it('answers for the call it asks about, and says what was decided', async () => {
    render(<RunControls run={asking()} />)

    await userEvent.click(screen.getByRole('button', { name: 'Allow for this run' }))
    expect(approveRunCall).toHaveBeenCalledWith('run-1', { callId: 'c7', allowed: true, forRun: true })
    expect(await screen.findByTestId('approval-decided')).toHaveTextContent('Allowed for the rest of this run')
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
  })

  it('shows why an answer did not reach the run, and lets it be tried again', async () => {
    vi.mocked(approveRunCall).mockRejectedValueOnce(new Error('the run is not waiting on that call'))
    render(<RunControls run={asking()} />)

    await userEvent.click(screen.getByRole('button', { name: 'Decline' }))
    expect(await screen.findByText('the run is not waiting on that call')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Decline' })).toBeEnabled()
  })

  it('is gone once the call has run', () => {
    const ran = asking()
    render(<RunControls run={{ ...ran, notices: [{ ...ran.notices[0]!, answered: true }] }} />)
    expect(screen.queryByTestId('approval')).toBeNull()
  })
})
