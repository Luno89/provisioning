import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as notificationsApi from '../../api/notifications'
import { Notifications } from './Notifications'

vi.mock('../../api/notifications', async (orig) => ({
  ...(await orig<typeof notificationsApi>()),
  getNotifications: vi.fn(),
  setEmailChoice: vi.fn(async (email: string) => ({ email, available: { ok: true } })),
  sendTestEmail: vi.fn(async () => undefined),
}))

const show = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Notifications />
  </QueryClientProvider>,
)

describe('Settings → Notifications', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('shows where alerts are emailed, changes which ones, and sends a test', async () => {
    vi.mocked(notificationsApi.getNotifications).mockResolvedValue({ email: 'all', available: { ok: true }, address: 'owner@example.com' })
    show()
    expect(await screen.findByText('owner@example.com')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Every alert/ })).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: /Only when something is down/ }))
    await waitFor(() => expect(notificationsApi.setEmailChoice).toHaveBeenCalledWith('down'))
    expect(await screen.findByRole('radio', { name: /Only when something is down/ })).toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: 'Send a test email' }))
    expect(await screen.findByText(/Sent\. Check your inbox/)).toBeInTheDocument()
  })

  it('says why email cannot be sent, and offers no choice or test', async () => {
    vi.mocked(notificationsApi.getNotifications).mockResolvedValue({ email: 'all', available: { ok: false, why: 'email is not set up on this platform (MAIL_SMTP_URL is unset)' } })
    show()
    expect(await screen.findByText(/Email cannot be sent from here: email is not set up on this platform/)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Every alert/ })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Send a test email' })).toBeNull()
  })
})
