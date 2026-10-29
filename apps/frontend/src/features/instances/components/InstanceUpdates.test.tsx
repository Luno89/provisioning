import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { InstanceUpdates } from './InstanceUpdates'
import { api } from '../../../api/client'

vi.mock('../../../api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../api/client')>()
  return { ...original, api: { get: vi.fn(), put: vi.fn() } }
})

const show = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><InstanceUpdates /></QueryClientProvider>)

const releases = [
  { imageTag: 'c3', version: 'v2026.10.26', servedAt: '2026-10-26T00:00:00.000Z', running: false, current: true, choosable: true, notes: 'Shipped and released from c3 after v2026.10.25: release-live.' },
  { imageTag: 'b2', version: 'v2026.10.25', servedAt: '2026-10-25T00:00:00.000Z', running: true, current: false, choosable: false, hotfix: true },
  { imageTag: 'a1', version: 'v2026.10.24', servedAt: '2026-10-24T00:00:00.000Z', running: false, current: false, choosable: true },
]

describe('an instance\'s updates in Settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockResolvedValue({ data: { auto: false, picked: 'b2', running: 'b2', previous: 'a1', current: 'c3', target: 'b2', releases } })
  })

  it('says what runs, offers newer releases and the one before, and marks hotfixes', async () => {
    show()
    expect(await screen.findByText('v2026.10.25', { selector: '.font-mono.text-slate-200' })).toBeInTheDocument()
    expect(within(screen.getByTestId('release-v2026.10.25')).getByText('Hotfix')).toBeInTheDocument()
    expect(within(screen.getByTestId('release-v2026.10.25')).queryByRole('button')).toBeNull()
    expect(within(screen.getByTestId('release-v2026.10.26')).getByRole('button', { name: 'Move to this version' })).toBeInTheDocument()
    expect(within(screen.getByTestId('release-v2026.10.24')).getByRole('button', { name: 'Go back to this version' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Update automatically/ })).not.toBeChecked()
  })

  it('moves to a release and says it is moving there', async () => {
    vi.mocked(api.put).mockResolvedValue({ data: { auto: false, picked: 'c3', running: 'b2', previous: 'a1', current: 'c3', target: 'c3', releases, checking: 'instance-self-upgrade-x' } })
    show()
    fireEvent.click(within(await screen.findByTestId('release-v2026.10.26')).getByRole('button', { name: 'Move to this version' }))
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/instance-updates', { version: 'v2026.10.26' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Moving to v2026.10.26')
  })

  it('switches automatic updates on', async () => {
    vi.mocked(api.put).mockResolvedValue({ data: { auto: true, running: 'b2', previous: 'a1', current: 'c3', target: 'c3', releases, checking: 'instance-self-upgrade-y' } })
    show()
    fireEvent.click(await screen.findByRole('checkbox', { name: /Update automatically/ }))
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/instance-updates', { auto: true }))
    expect(await screen.findByRole('checkbox', { name: /Update automatically/ })).toBeChecked()
  })

  it('shows nothing where the instance takes no updates from root', async () => {
    vi.mocked(api.get).mockRejectedValue(Object.assign(new Error('404'), { isAxiosError: true, response: { status: 404 } }))
    const { container } = show()
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('says which advisories the release it runs carries, and which newer release fixes them', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => (url === '/instance-updates/findings'
      ? { data: { release: 'v2026.10.25', findings: [
        { component: { name: 'seroval', version: '1.6.7', kind: 'npm' }, advisory: { id: 'GHSA-x', severity: 'high' }, state: 'due', fix: '1.6.8', fixedBy: 'v2026.10.26' },
      ] } }
      : { data: { auto: false, picked: 'b2', running: 'b2', previous: 'a1', current: 'c3', target: 'b2', releases } }))
    show()
    const advisories = await screen.findByTestId('release-advisories')
    expect(advisories).toHaveTextContent('Your release, v2026.10.25, has 1 known advisory; v2026.10.26 fixes it.')
    expect(advisories).toHaveTextContent('seroval@1.6.7: GHSA-x (high) · Update due · fixed in v2026.10.26')
  })
})
