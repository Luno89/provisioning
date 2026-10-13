import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Becomes } from './Becomes'

vi.mock('../../api/grove', async (original) => ({
  ...(await original<typeof import('../../api/grove')>()),
  getTreeTypeDescription: vi.fn(),
}))
const { getTreeTypeDescription } = await import('../../api/grove')

const show = (typeId: string) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Becomes typeId={typeId} />
  </QueryClientProvider>,
)

describe('what a tree type becomes', () => {
  it('shows the description the platform puts together, sections and all', async () => {
    vi.mocked(getTreeTypeDescription).mockResolvedValue('Odoo addons (odoo-addons): customisations\n\nTHE PLATFORM DOES THESE, SO NEVER PLAN THEM\n- deploying or releasing')
    show('odoo-addons')
    expect(await screen.findByText(/THE PLATFORM DOES THESE, SO NEVER PLAN THEM/)).toBeInTheDocument()
    expect(getTreeTypeDescription).toHaveBeenCalledWith('odoo-addons')
  })

  it('says why when it cannot be described', async () => {
    vi.mocked(getTreeTypeDescription).mockRejectedValue(Object.assign(new Error('There is no tree type "nope".'), { isAxiosError: false }))
    show('nope')
    expect(await screen.findByText(/no tree type "nope"/)).toBeInTheDocument()
  })
})
