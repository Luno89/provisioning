import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as meshApi from '../../api/mesh'
import OwnHardwareSection from './OwnHardwareSection'

vi.mock('../../api/mesh', async (orig) => ({
  ...(await orig<typeof meshApi>()),
  getMeshConfig: vi.fn(),
  listMeshDevices: vi.fn(),
  createPreauthKey: vi.fn(),
  deleteMeshDevice: vi.fn(async () => undefined),
}))

const show = (config: unknown, devices: unknown[] = []) => {
  vi.mocked(meshApi.getMeshConfig).mockResolvedValue(config as never)
  vi.mocked(meshApi.listMeshDevices).mockResolvedValue(devices as never)
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><OwnHardwareSection /></QueryClientProvider>)
}

const CONFIGURED = { loginServer: 'https://mesh.example.com', configured: true }

describe('your own hardware', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('says the mesh is unreachable when no public login server is set, and gives no command', async () => {
    show({ loginServer: null, configured: false })
    expect(await screen.findByText(/mesh isn't reachable yet/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /generate join command/i })).toBeDisabled()
  })

  it('gives a join command once the mesh is public', async () => {
    vi.mocked(meshApi.createPreauthKey).mockResolvedValue({ key: 'k-1' } as never)
    show(CONFIGURED)
    await waitFor(() => expect(screen.getByRole('button', { name: /generate join command/i })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: /generate join command/i }))
    expect(await screen.findByText(/--login-server=https:\/\/mesh\.example\.com --authkey=k-1/)).toBeInTheDocument()
  })

  it('lists the machines on the mesh and removes one', async () => {
    show(CONFIGURED, [{ id: 'n1', name: 'gpu-box', online: true, ipAddresses: ['100.64.0.5'] }])
    expect(await screen.findByTestId('mesh-device')).toHaveTextContent('100.64.0.5')
    fireEvent.click(screen.getByRole('button', { name: 'Remove gpu-box from the mesh' }))
    await waitFor(() => expect(meshApi.deleteMeshDevice).toHaveBeenCalledWith('n1'))
  })
})
