import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LiveCustomizations } from './LiveCustomizations'
import * as api from '../api/customizations'

vi.mock('../api/customizations', async (orig) => ({
  ...(await orig<typeof api>()),
  getDrift: vi.fn(),
  proposeAdoption: vi.fn(async () => ({ id: 'card-1' })),
}))

const show = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <LiveCustomizations projectId="p1" />
  </QueryClientProvider>,
)

describe('what was made in the live app', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists it, and proposes bringing in what stays ticked', async () => {
    vi.mocked(api.getDrift).mockResolvedValue({ projectId: 'p1', project: 'Shop', module: 'shop_customizations', items: [
      { kind: 'field', key: 'koala.probe.x_note', name: 'The field Note (x_note) on koala.probe, made in the app,' },
      { kind: 'edited-view', key: 'id:186', name: 'The view koala.probe.form, edited in the app,' },
    ] })
    show()
    expect(await screen.findByText('The field Note (x_note) on koala.probe, made in the app')).toBeInTheDocument()
    expect(screen.getByText('(edited view)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Bring them all into git/ })).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('checkbox')[1]!)
    fireEvent.click(screen.getByRole('button', { name: /Bring 1 into git/ }))
    await waitFor(() => expect(api.proposeAdoption).toHaveBeenCalledWith('p1', ['field/koala.probe.x_note'], expect.any(String)))
    expect(await screen.findByText(/It waits for you on a card in the project's channel/)).toBeInTheDocument()
  })

  it('says when there is nothing outside git', async () => {
    vi.mocked(api.getDrift).mockResolvedValue({ projectId: 'p1', project: 'Shop', module: 'shop_customizations', items: [] })
    show()
    expect(await screen.findByText('Nothing was made or changed in the live app that is not in git.')).toBeInTheDocument()
  })
})
