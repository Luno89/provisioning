import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import CheckResult from './CheckResult'
import type { ScenarioResult } from '../../api/evals'

const traced = vi.hoisted(() => ({ runIds: [] as string[] }))
vi.mock('./ScenarioTrace', () => ({ default: ({ result }: { result: ScenarioResult }) => { traced.runIds.push(result.runId); return <div data-testid="trace">{result.runId}</div> } }))

const attempt = (runId: string, passed: boolean, detail: string) => ({ runId, passed, durationMs: 1, calls: [{ name: passed ? 'start_task' : 'list_dir', ok: true, digest: '' }], checks: [{ what: 'chooses start_task', passed, detail }] })

const repeated: ScenarioResult = {
  scenarioId: 'turn-claims', name: 'claims', runId: 'run-2', procedure: { id: 'turn-check', version: '1' }, passed: false, outcome: 'ok', answer: '',
  checks: [{ what: 'passes all 2 times', passed: false, detail: '1 of 2 passed' }, { what: 'chooses start_task — 1/2', passed: false, detail: 'called list_dir instead of start_task' }],
  calls: [], counters: { rounds: 1, toolCalls: 0, totalTokens: 1 }, tasks: [], durationMs: 2,
  repeats: 2, passAt: 2, passedAttempts: 1,
  attempts: [attempt('run-1', true, 'it called start_task'), attempt('run-2', false, 'called list_dir instead of start_task')],
}

describe('a repeated check\'s result', () => {
  it('shows how often each expectation held, opens on the attempt it shows, and switches to another', () => {
    render(<CheckResult result={repeated} />)

    expect(screen.getByText('chooses start_task — 1/2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Attempt 2, failed' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('trace')).toHaveTextContent('run-2')
    expect(screen.getByText('list_dir')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Attempt 1, passed' }))
    expect(screen.getByTestId('trace')).toHaveTextContent('run-1')
    expect(screen.getByText('it called start_task')).toBeInTheDocument()
    expect(screen.getByText('start_task')).toBeInTheDocument()
  })

  it('shows a single run as it always has, with no attempts', () => {
    const { attempts: _attempts, repeats: _repeats, passAt: _passAt, passedAttempts: _passed, ...single } = repeated
    render(<CheckResult result={{ ...single, answer: 'Claimed.' }} />)
    expect(screen.queryByRole('group', { name: 'Attempts' })).not.toBeInTheDocument()
    expect(screen.getByText('Claimed.')).toBeInTheDocument()
  })
})
