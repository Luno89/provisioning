import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as notificationsApi from '../../monitoring/api/notifications'
import * as thisDevice from '../lib/this-device'
import { PushDevices } from './PushDevices'

vi.mock('../../monitoring/api/notifications', async (orig) => ({
  ...(await orig<typeof notificationsApi>()),
  getPush: vi.fn(),
  addPushDevice: vi.fn(),
  removePushDevice: vi.fn(),
  sendTestPush: vi.fn(async () => ({ sent: 1 })),
}))

vi.mock('../lib/this-device', async (orig) => ({
  ...(await orig<typeof thisDevice>()),
  abilitiesOf: vi.fn(() => ({ serviceWorker: true, pushManager: true, permission: 'default', appleMobile: false, standalone: false })),
  subscribeThisDevice: vi.fn(async () => ({ endpoint: 'https://push.example/here', keys: { p256dh: 'p', auth: 'a' } })),
  thisDeviceEndpoint: vi.fn(async () => undefined),
  unsubscribeThisDevice: vi.fn(async () => undefined),
}))

const here = { id: 'd1', label: 'Chrome on Linux', endpoint: 'https://push.example/here', createdAt: 'now' }

const show = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <PushDevices />
  </QueryClientProvider>,
)

describe('Settings → Notifications → my devices', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('switches this device on, marks it, sends it a test and stops it', async () => {
    vi.mocked(notificationsApi.getPush).mockResolvedValue({ publicKey: 'BAEC_w', devices: [] })
    vi.mocked(notificationsApi.addPushDevice).mockResolvedValue({ publicKey: 'BAEC_w', devices: [here] })
    vi.mocked(notificationsApi.removePushDevice).mockResolvedValue({ publicKey: 'BAEC_w', devices: [] })
    vi.mocked(thisDevice.thisDeviceEndpoint).mockImplementation(async () => (vi.mocked(notificationsApi.addPushDevice).mock.calls.length > 0 ? here.endpoint : undefined))
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Notify this device' }))
    await waitFor(() => expect(thisDevice.subscribeThisDevice).toHaveBeenCalledWith('BAEC_w'))
    expect(notificationsApi.addPushDevice).toHaveBeenCalledWith({ endpoint: 'https://push.example/here', keys: { p256dh: 'p', auth: 'a' } })
    expect(await screen.findByText('· this device')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Notify this device' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Send a test push' }))
    expect(await screen.findByText('Sent to one device.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Stop notifying Chrome on Linux (this device)' }))
    await waitFor(() => expect(notificationsApi.removePushDevice).toHaveBeenCalledWith('d1'))
    expect(thisDevice.unsubscribeThisDevice).toHaveBeenCalled()
  })

  it('tells an iPhone to add Koala to the Home Screen first, and offers no switch', async () => {
    vi.mocked(thisDevice.abilitiesOf).mockReturnValue({ serviceWorker: true, pushManager: false, permission: 'unsupported', appleMobile: true, standalone: false })
    vi.mocked(notificationsApi.getPush).mockResolvedValue({ publicKey: 'BAEC_w', devices: [] })
    show()
    expect(await screen.findByText(/add Koala to your Home Screen first/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Notify this device' })).not.toBeInTheDocument()
  })
})
