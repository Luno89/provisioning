import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { InstanceAddresses } from './InstanceAddresses'
import * as addressesApi from '../../instances/api/instance-addresses'

vi.mock('../../instances/api/instance-addresses', async (importOriginal) => ({
  ...(await importOriginal<typeof addressesApi>()),
  getInstanceAddresses: vi.fn(),
  setNestedAddresses: vi.fn(),
}))

const renderSection = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><InstanceAddresses /></QueryClientProvider>)
}

describe('an instance\'s addresses in Settings', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows nothing where the instance has no addresses of its own', async () => {
    vi.mocked(addressesApi.getInstanceAddresses).mockResolvedValue(null)
    const { container } = renderSection()
    await waitFor(() => expect(addressesApi.getInstanceAddresses).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('switches to nested addresses and says while the certificate is being issued, with why it is not yet', async () => {
    vi.mocked(addressesApi.getInstanceAddresses).mockResolvedValue({ nested: false, name: 'luno', domain: 'koala.dev' })
    vi.mocked(addressesApi.setNestedAddresses).mockResolvedValue({ nested: true, state: 'issuing', detail: "Let's Encrypt is refusing new certificates for now (its weekly limit)", name: 'luno', domain: 'koala.dev' })
    renderSection()
    expect(await screen.findByText('<app>-luno.koala.dev')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use nested addresses' }))
    expect(await screen.findByText(/Getting the certificate for \*\.luno\.koala\.dev/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('weekly limit')
    expect(addressesApi.setNestedAddresses).toHaveBeenCalledWith(true)
  })

  it('says when nested addresses are in use, and can go back', async () => {
    vi.mocked(addressesApi.getInstanceAddresses).mockResolvedValue({ nested: true, state: 'ready', name: 'luno', domain: 'koala.dev' })
    vi.mocked(addressesApi.setNestedAddresses).mockResolvedValue({ nested: false, name: 'luno', domain: 'koala.dev' })
    renderSection()
    expect(await screen.findByText('Your apps show their nested addresses.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Go back to flat addresses only' }))
    expect(await screen.findByRole('button', { name: 'Use nested addresses' })).toBeInTheDocument()
  })
})
