import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Release } from './Release'
import * as api from '../../../releases/api/release-settings'
import type { TreeType } from './shared'

vi.mock('../../../releases/api/release-settings', async (importOriginal) => ({ ...(await importOriginal<typeof api>()), getReleaseOptions: vi.fn() }))

const type = { id: 'odoo-addons', label: 'Odoo', summary: 's', language: 'odoo', produces: 'service', doneMeans: 'd', files: [] } as unknown as TreeType

const show = (value: TreeType, onChange = vi.fn()) => {
  vi.mocked(api.getReleaseOptions).mockResolvedValue({
    agents: [{ slug: 'release', name: 'Release', needsApp: true, description: 'beside the live slot' }, { slug: 'release-replace', name: 'Release by replacing', needsApp: false }],
    apps: [{ id: 'odoo', title: 'Odoo' }],
  })
  render(<QueryClientProvider client={new QueryClient()}><Release value={value} onChange={onChange} /></QueryClientProvider>)
  return onChange
}

describe('a tree type\'s release, in the Studio', () => {
  it('picks the agent that releases, with the app adapter when it needs one', async () => {
    const onChange = show(type)
    await screen.findByRole('option', { name: 'Release (release)' })
    fireEvent.change(screen.getByLabelText('Agent that releases builds'), { target: { value: 'release' } })
    expect(onChange).toHaveBeenLastCalledWith({ release: { agent: 'release', app: 'odoo' } })
    fireEvent.change(screen.getByLabelText('Agent that releases builds'), { target: { value: 'release-replace' } })
    expect(onChange).toHaveBeenLastCalledWith({ release: { agent: 'release-replace' } })
    fireEvent.change(screen.getByLabelText('Agent that releases builds'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith({ release: undefined })
  })

  it('shows the adapter only for an agent that releases beside the live app', async () => {
    show({ ...type, release: { agent: 'release', app: 'odoo' } })
    expect(await screen.findByLabelText('App adapter')).toBeDefined()
    expect(screen.getByText('beside the live slot')).toBeDefined()
  })
})
