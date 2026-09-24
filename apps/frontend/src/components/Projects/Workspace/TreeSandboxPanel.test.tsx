import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TreeSandboxPanel } from './TreeSandboxPanel.js'
import * as groveApi from '../../../api/grove.js'

vi.mock('../../../api/grove.js', async (importOriginal) => ({
  ...(await importOriginal<typeof groveApi>()),
  getTreeWorkspace: vi.fn(),
  releaseTreeWorkspace: vi.fn(),
}))

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TreeSandboxPanel treeId="t1" />
    </QueryClientProvider>,
  )
}

describe('TreeSandboxPanel', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('says the files are kept while the pod is parked', async () => {
    vi.mocked(groveApi.getTreeWorkspace).mockResolvedValue({ state: 'parked' })
    renderPanel()
    expect(await screen.findByText(/files are kept on its volume/)).toBeTruthy()
  })

  it('releases only after a second, explicit confirmation, then shows there is none', async () => {
    vi.mocked(groveApi.getTreeWorkspace).mockResolvedValue({ state: 'running' })
    vi.mocked(groveApi.releaseTreeWorkspace).mockResolvedValue({ state: 'none' })
    renderPanel()

    fireEvent.click(await screen.findByText('Release sandbox'))
    expect(groveApi.releaseTreeWorkspace).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Delete it'))
    await waitFor(() => expect(groveApi.releaseTreeWorkspace).toHaveBeenCalledWith('t1'))
    expect(await screen.findByText(/No sandbox/)).toBeTruthy()
    expect(screen.queryByText('Release sandbox')).toBeNull()
  })

  it('offers nothing to release when there is no sandbox', async () => {
    vi.mocked(groveApi.getTreeWorkspace).mockResolvedValue({ state: 'none' })
    renderPanel()
    expect(await screen.findByText(/No sandbox/)).toBeTruthy()
    expect(screen.queryByText('Release sandbox')).toBeNull()
  })
})
