import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RunControls from './RunControls'
import { emptyRunState, type EngineRunState } from '../../lib/engine-run-state'

vi.mock('../../api/engine', async (orig) => ({ ...(await orig<typeof import('../../api/engine')>()), answerRun: vi.fn(async () => undefined) }))
const { answerRun } = await import('../../api/engine')

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
