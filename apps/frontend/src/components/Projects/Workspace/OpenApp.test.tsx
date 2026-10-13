import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { OpenApp } from './OpenApp'
import * as appApi from '../../../api/project-app'

vi.mock('../../../api/project-app', async (orig) => ({
  ...(await orig<typeof appApi>()),
  getProjectApp: vi.fn(),
  openProjectApp: vi.fn(),
}))

const renderOpen = (which?: 'app' | 'preview') => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <OpenApp projectId="p1" which={which} />
  </QueryClientProvider>,
)

const running = (over: Partial<appApi.ProjectApp> = {}): appApi.ProjectApp => ({ id: 'd1', name: 'Shop', status: 'running', local: {}, public: {}, ...over })

describe('opening a project\'s app', () => {
  let tab: { location: { href: string }; opener: unknown; close: ReturnType<typeof vi.fn> }
  beforeEach(() => {
    vi.clearAllMocks()
    tab = { location: { href: 'about:blank' }, opener: window, close: vi.fn() }
    vi.spyOn(window, 'open').mockImplementation(() => tab as unknown as Window)
  })
  afterEach(() => vi.restoreAllMocks())

  it('exposes it on this machine when it is not yet, and sends the tab it opened at the click there', async () => {
    vi.mocked(appApi.getProjectApp).mockResolvedValue(running())
    vi.mocked(appApi.openProjectApp).mockResolvedValue(running({ local: { app: 'http://shop.localhost:8000', preview: 'http://shop-preview.localhost:8000' } }))
    renderOpen()

    fireEvent.click(await screen.findByRole('button', { name: /open app/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /expose on this machine and open/i }))
    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank')
    expect(tab.opener).toBeNull()
    await waitFor(() => expect(tab.location.href).toBe('http://shop.localhost:8000'))
    expect(appApi.openProjectApp).toHaveBeenCalledWith('p1', 'local')
  })

  it('opens an address it already has straight away, and opens the preview\'s for the preview', async () => {
    vi.mocked(appApi.getProjectApp).mockResolvedValue(running({ local: { app: 'http://shop.localhost:8000', preview: 'http://shop-preview.localhost:8000' } }))
    renderOpen('preview')
    fireEvent.click(await screen.findByRole('button', { name: /open preview/i }))
    expect(screen.getByText('shop-preview.localhost:8000')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: /on this machine/i }))
    expect(window.open).toHaveBeenCalledWith('http://shop-preview.localhost:8000', '_blank', 'noopener,noreferrer')
    expect(appApi.openProjectApp).not.toHaveBeenCalled()
  })

  it('says publicly means anyone, exposes publicly only when chosen, and closes the tab and says why when it cannot', async () => {
    vi.mocked(appApi.getProjectApp).mockResolvedValue(running())
    vi.mocked(appApi.openProjectApp).mockRejectedValue({ response: { data: { error: 'the tunnel would not start' } } })
    renderOpen()
    fireEvent.click(await screen.findByRole('button', { name: /open app/i }))
    expect(screen.getByText('Anyone with the address can reach it, from anywhere.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: /expose publicly and open/i }))
    await waitFor(() => expect(tab.close).toHaveBeenCalled())
    expect(appApi.openProjectApp).toHaveBeenCalledWith('p1', 'public')
  })

  it('offers nothing while the project has no running app', async () => {
    vi.mocked(appApi.getProjectApp).mockResolvedValue(null)
    const { container } = renderOpen()
    await waitFor(() => expect(appApi.getProjectApp).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
