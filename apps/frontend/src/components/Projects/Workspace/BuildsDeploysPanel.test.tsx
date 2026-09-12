import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BuildsDeploysPanel, type LinkedProject } from './BuildsDeploysPanel.js'
import * as projectsApi from '../../../api/projects.js'
import * as localAgentsApi from '../../../api/local-agents.js'

vi.mock('../../../api/projects.js', async (importOriginal) => ({
  ...(await importOriginal<typeof projectsApi>()),
  listProjectRuns: vi.fn(),
  listProjects: vi.fn(),
  patchProject: vi.fn(),
}))

vi.mock('../../../api/local-agents.js', async (importOriginal) => ({
  ...(await importOriginal<typeof localAgentsApi>()),
  listLocalAgentDevices: vi.fn(),
}))

const project: LinkedProject = {
  id: 'p1', name: 'demo', giteaOwner: 'acme', giteaRepo: 'demo',
}

function renderPanel(p: LinkedProject = project) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <BuildsDeploysPanel project={p} />
    </QueryClientProvider>,
  )
}

describe('BuildsDeploysPanel — execution target', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('offers registered devices, alongside the sandboxed default', async () => {
    vi.mocked(projectsApi.listProjectRuns).mockResolvedValue([])
    vi.mocked(projectsApi.listProjects).mockResolvedValue([project])
    vi.mocked(localAgentsApi.listLocalAgentDevices).mockResolvedValue([
      { id: 'dev-1', name: 'My Laptop', rootDir: '/x', createdAt: '2026-01-01T00:00:00Z', online: true },
    ])

    renderPanel()

    expect(await screen.findByRole('option', { name: 'My Laptop' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Sandboxed cluster (default)' })).toBeInTheDocument()
  })

  it('defaults the select to the sandboxed option when no device is set', async () => {
    vi.mocked(projectsApi.listProjectRuns).mockResolvedValue([])
    vi.mocked(projectsApi.listProjects).mockResolvedValue([project])
    vi.mocked(localAgentsApi.listLocalAgentDevices).mockResolvedValue([])

    renderPanel()

    expect(await screen.findByDisplayValue('Sandboxed cluster (default)')).toBeInTheDocument()
  })

  it('calls patchProject with the chosen device on change', async () => {
    vi.mocked(projectsApi.listProjectRuns).mockResolvedValue([])
    vi.mocked(projectsApi.listProjects).mockResolvedValue([project])
    vi.mocked(localAgentsApi.listLocalAgentDevices).mockResolvedValue([
      { id: 'dev-1', name: 'My Laptop', rootDir: '/x', createdAt: '2026-01-01T00:00:00Z', online: true },
    ])
    vi.mocked(projectsApi.patchProject).mockResolvedValue({})

    renderPanel()
    await screen.findByRole('option', { name: 'My Laptop' })

    fireEvent.change(screen.getByDisplayValue('Sandboxed cluster (default)'), { target: { value: 'dev-1' } })

    await waitFor(() => expect(projectsApi.patchProject).toHaveBeenCalledWith('p1', { executionTargetDeviceId: 'dev-1' }))
  })

  it('shows a device already claimed by another project as disabled', async () => {
    vi.mocked(projectsApi.listProjectRuns).mockResolvedValue([])
    vi.mocked(projectsApi.listProjects).mockResolvedValue([
      project,
      { id: 'p2', name: 'other-project', executionTarget: { kind: 'local-device', deviceId: 'dev-1' } },
    ])
    vi.mocked(localAgentsApi.listLocalAgentDevices).mockResolvedValue([
      { id: 'dev-1', name: 'My Laptop', rootDir: '/x', createdAt: '2026-01-01T00:00:00Z', online: true },
    ])

    renderPanel()

    const option = await screen.findByRole('option', { name: /My Laptop — in use by other-project/ })
    expect(option).toBeDisabled()
  })

  it('does not disable a device that is only claimed at a different subfolder', async () => {
    vi.mocked(projectsApi.listProjectRuns).mockResolvedValue([])
    vi.mocked(projectsApi.listProjects).mockResolvedValue([
      project,
      { id: 'p2', name: 'other-project', executionTarget: { kind: 'local-device', deviceId: 'dev-1', path: 'apps/one' } },
    ])
    vi.mocked(localAgentsApi.listLocalAgentDevices).mockResolvedValue([
      { id: 'dev-1', name: 'My Laptop', rootDir: '/x', createdAt: '2026-01-01T00:00:00Z', online: true },
    ])

    renderPanel()

    const option = await screen.findByRole('option', { name: 'My Laptop' })
    expect(option).not.toBeDisabled()
  })

  it('reverts to the sandboxed default when cleared', async () => {
    vi.mocked(projectsApi.listProjectRuns).mockResolvedValue([])
    vi.mocked(projectsApi.listProjects).mockResolvedValue([
      { ...project, executionTarget: { kind: 'local-device', deviceId: 'dev-1' } },
    ])
    vi.mocked(localAgentsApi.listLocalAgentDevices).mockResolvedValue([
      { id: 'dev-1', name: 'My Laptop', rootDir: '/x', createdAt: '2026-01-01T00:00:00Z', online: true },
    ])
    vi.mocked(projectsApi.patchProject).mockResolvedValue({})

    renderPanel({ ...project, executionTarget: { kind: 'local-device', deviceId: 'dev-1' } })
    await screen.findByRole('option', { name: 'My Laptop' })

    fireEvent.change(screen.getByDisplayValue('My Laptop'), { target: { value: '' } })

    await waitFor(() => expect(projectsApi.patchProject).toHaveBeenCalledWith('p1', { executionTargetDeviceId: '' }))
  })
})
