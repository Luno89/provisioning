import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as hubApi from '../api'
import SharedProjectsLink from './SharedProjectsLink'

const navigate = vi.fn()

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}))

vi.mock('../api', async (orig) => ({
  ...(await orig<typeof hubApi>()),
  hubElsewhere: vi.fn(),
}))

const show = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SharedProjectsLink className="" active={false} /></QueryClientProvider>)

beforeEach(() => { vi.clearAllMocks() })

describe('Shared projects in the sidebar', () => {
  it('on an instance opens the hub, signed in through root, landing on the shared projects', async () => {
    vi.mocked(hubApi.hubElsewhere).mockResolvedValue('https://koala.dev/api/identity/go?to=hub')
    show()
    const link = await screen.findByRole('link', { name: 'Shared projects' })
    expect(link).toHaveAttribute('href', 'https://koala.dev/api/identity/go?to=hub&next=%2Fshared')
  })

  it('offers no link when the hub address it is given is not a web address', async () => {
    vi.mocked(hubApi.hubElsewhere).mockResolvedValue('javascript:alert(1)//?x=1')
    show()
    expect(await screen.findByText('Shared projects')).toBeInTheDocument()
    expect(screen.getByText('Shared projects').closest('a')).not.toHaveAttribute('href')
  })

  it('where the hub is this Koala, goes to the shared projects in place', async () => {
    vi.mocked(hubApi.hubElsewhere).mockResolvedValue(null)
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Shared projects' }))
    expect(navigate).toHaveBeenCalledWith({ to: '/shared' })
  })
})
