import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProjectRelease } from './ProjectRelease'
import * as api from '../../../api/release-settings'

vi.mock('../../../api/release-settings', async (importOriginal) => ({ ...(await importOriginal<typeof api>()), getReleaseOptions: vi.fn(), getProjectRelease: vi.fn(), setProjectRelease: vi.fn() }))

describe('how a project\'s builds are released', () => {
  it('says where its release comes from, overrides its type\'s, and goes back to it', async () => {
    vi.mocked(api.getReleaseOptions).mockResolvedValue({ agents: [{ slug: 'release', name: 'Release', needsApp: true }, { slug: 'release-replace', name: 'Release by replacing', needsApp: false }], apps: [{ id: 'odoo', title: 'Odoo' }] })
    vi.mocked(api.getProjectRelease).mockResolvedValue({ how: { agent: 'release', app: 'odoo' }, from: 'tree type' })
    vi.mocked(api.setProjectRelease).mockResolvedValue({ how: { agent: 'release-replace' }, from: 'project' })
    render(<QueryClientProvider client={new QueryClient()}><ProjectRelease projectId="p1" /></QueryClientProvider>)

    expect(await screen.findByText(/as its tree type says/)).toBeDefined()
    fireEvent.change(screen.getByLabelText('How this project\'s builds are released'), { target: { value: 'release-replace' } })
    await waitFor(() => expect(api.setProjectRelease).toHaveBeenCalledWith('p1', { agent: 'release-replace' }))
    expect(await screen.findByText(/set for this project/)).toBeDefined()
    fireEvent.change(screen.getByLabelText('How this project\'s builds are released'), { target: { value: '' } })
    await waitFor(() => expect(api.setProjectRelease).toHaveBeenLastCalledWith('p1', null))
  })
})
