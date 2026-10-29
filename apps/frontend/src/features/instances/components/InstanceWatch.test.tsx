import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { InstanceWatch } from './InstanceWatch'
import { api } from '../../../api/client'

vi.mock('../../../api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../api/client')>()
  return { ...original, api: { get: vi.fn(), put: vi.fn() } }
})

const show = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><InstanceWatch /></QueryClientProvider>)

describe('an instance\'s Settings: when it cannot be reached', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('switches root\'s emails for an instance on its own machine', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { notifyWhenUnreachable: true, alwaysTold: false } })
    vi.mocked(api.put).mockResolvedValue({ data: { notifyWhenUnreachable: false, alwaysTold: false } })
    show()
    const box = await screen.findByRole('checkbox', { name: /Email me when my instance stops answering/ })
    expect(box).toBeChecked()
    fireEvent.click(box)
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/instance-watch', { notifyWhenUnreachable: false }))
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked())
  })

  it('says a trial on Koala\'s servers is always watched, and offers no switch', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { notifyWhenUnreachable: true, alwaysTold: true } })
    show()
    expect(await screen.findByText(/always emails you, and Koala's operator/)).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('shows nothing where root watches no instance', async () => {
    vi.mocked(api.get).mockRejectedValue(Object.assign(new Error('nope'), { isAxiosError: true, response: { status: 404 } }))
    const { container } = show()
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
