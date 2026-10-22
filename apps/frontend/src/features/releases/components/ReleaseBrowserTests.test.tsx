import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ReleaseBrowserTests } from './ReleaseBrowserTests'
import type { OdooRelease } from '../api/releases'

const outline = 'URL: http://shop-odoo-b:8069/odoo/sales/new\nButtons: "Save manually" .o_form_button_save'

const release: OdooRelease = {
  id: 'r1', projectId: 'p1', pipelineRunId: 'run-1', commit: 'abcdef12', image: 'img', slot: 'b', state: 'preview', host: 'shop', startedAt: 't', updatedAt: 't',
  e2e: {
    state: 'failed',
    summary: '1 passed, 1 failed',
    startedAt: 't',
    tests: [
      { title: 'confirms an order', file: 'order.spec.ts', status: 'failed', durationMs: 10_000, error: 'Timeout 10000ms exceeded', page: outline },
      { title: 'signs in', file: 'signs-in.spec.ts', status: 'passed', durationMs: 900 },
    ],
  },
}

describe('a release\'s browser tests', () => {
  it('keeps what the page showed under a failed test, a click away', () => {
    render(<QueryClientProvider client={new QueryClient()}><ReleaseBrowserTests projectId="p1" release={release} /></QueryClientProvider>)

    expect(screen.getByText('Timeout 10000ms exceeded')).toBeTruthy()
    const shown = screen.getByTestId('page-at-failure')
    expect(shown.hasAttribute('open')).toBe(false)
    fireEvent.click(screen.getByText('What the page showed'))
    expect(shown.textContent).toContain('"Save manually" .o_form_button_save')
    expect(screen.getAllByTestId('page-at-failure')).toHaveLength(1)
  })
})
