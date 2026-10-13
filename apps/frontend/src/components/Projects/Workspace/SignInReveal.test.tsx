import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SignInReveal } from './SignInReveal'
import * as releasesApi from '../../../api/releases'

vi.mock('../../../api/releases', async (orig) => ({
  ...(await orig<typeof releasesApi>()),
  getSignIn: vi.fn(),
}))

const renderReveal = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <SignInReveal projectId="p1" />
  </QueryClientProvider>,
)

describe('showing an app\'s sign-in', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reads the vault only when asked, shows the login and password, and hides them again', async () => {
    vi.mocked(releasesApi.getSignIn).mockResolvedValue([{ login: 'admin', password: 'from-the-vault', describe: 'The password of Odoo\'s admin user.' }])
    renderReveal()
    expect(releasesApi.getSignIn).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /show sign-in/i }))
    expect(await screen.findByText('from-the-vault')).toBeInTheDocument()
    expect(screen.getByText('admin')).toBeInTheDocument()
    expect(releasesApi.getSignIn).toHaveBeenCalledWith('p1')

    fireEvent.click(screen.getByRole('button', { name: /hide/i }))
    expect(screen.queryByText('from-the-vault')).toBeNull()
  })

  it('says so when the project\'s vault holds no sign-in yet', async () => {
    vi.mocked(releasesApi.getSignIn).mockResolvedValue([])
    renderReveal()
    fireEvent.click(screen.getByRole('button', { name: /show sign-in/i }))
    expect(await screen.findByText('No sign-in is in the project\'s vault yet.')).toBeInTheDocument()
  })
})
