import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { InstanceWatch } from './InstanceWatch'
import { api } from '../../../api/client'

vi.mock('../../../api/client', async (importOriginal) => (await import('../../../test/mocked-api')).mockedApi(importOriginal, 'get', 'put'))

const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return { client, ...render(<QueryClientProvider client={client}><InstanceWatch /></QueryClientProvider>) }
}

describe('an instance\'s Settings: when it cannot be reached', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('switches root\'s emails for an instance on its own machine', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { notifyWhenUnreachable: true } })
    vi.mocked(api.put).mockResolvedValue({ data: { notifyWhenUnreachable: false } })
    show()
    const box = await screen.findByRole('checkbox', { name: /Email me when my instance stops answering/ })
    expect(box).toBeChecked()
    fireEvent.click(box)
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/instance-watch', { notifyWhenUnreachable: false }))
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked())
  })

  it('shows nothing where root watches no instance', async () => {
    vi.mocked(api.get).mockRejectedValue(Object.assign(new Error('nope'), { isAxiosError: true, response: { status: 404 } }))
    const { client, container } = show()
    await waitFor(() => expect(client.getQueryCache().getAll().map((query) => [query.state.status, query.state.data])).toEqual([['success', null]]))
    expect(container).toBeEmptyDOMElement()
  })
})
