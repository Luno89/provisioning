import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import ExtensionsView from './Studio/ExtensionsView'
import { RunSignals } from './EngineRun/PoisoningSignals'
import { logout } from '../../platform'
import { startBackend } from '../../../test/backend/site'
import { mountEngine } from '../../../test/backend/engine'
import { shown } from '../../../test/backend/hooks'

const backend = await startBackend((site) => { mountEngine(site) })
const owner = await backend.signIn()
await backend.db.engine.savePoisoningSignal({
  id: 'finding-host', ownerId: owner.id, kind: 'unvouched-host', severity: 'medium', state: 'open', at: new Date().toISOString(), readsKey: 'reads-1', runId: 'run-poisoned', tool: 'fetch_web_page', said: 'fetched a host only a log named', host: 'evil.example',
})

const opened = (part: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{part}</QueryClientProvider>)

describe('the engine\'s pages, once the person\'s session has ended elsewhere', () => {
  it('says why a finding in a run could not be dismissed, and leaves it open', async () => {
    const page = opened(<RunSignals runId="run-poisoned" />)
    const finding = await shown(() => screen.queryByTestId('poisoning-signal'))
    await logout()
    await userEvent.click(within(finding).getByRole('button', { name: 'Dismiss' }))
    expect((await shown(() => within(finding).queryByRole('alert'))).textContent).toBe('Unauthorized: Session missing')
    expect(within(finding).getByRole('button', { name: 'Dismiss' })).toBeTruthy()
    page.unmount()
  })

  it('says why the extensions cannot be listed', async () => {
    const page = opened(<ExtensionsView />)
    expect((await shown(() => screen.queryByRole('alert'))).textContent).toBe('Unauthorized: Session missing')
    expect(screen.queryByRole('button', { name: /New extension/ })).toBeNull()
    page.unmount()
    await backend.signIn()
  })
})
