import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TreeWorkspaceFilePanel } from './TreeWorkspaceFilePanel.js'
import * as groveApi from '../../api/grove.js'

vi.mock('../../../engine/api/workspaceDependencies', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../engine/api/workspaceDependencies')>()),
  useDependencies: () => ({ isPending: false, data: [{ name: 'koala-e2e', summary: 'koala-e2e: runs a project\'s Playwright specs.', provides: ['koala-e2e'], install: [], mine: false, script: true, usedBy: { tools: [], servers: [], dependencies: [], steps: [], trees: [] } }] }),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ children }: { children: unknown }) => children,
}))

vi.mock('../../api/grove.js', async (importOriginal) => ({
  ...(await importOriginal<typeof groveApi>()),
  getTreeWorkspaceFile: vi.fn(),
  saveTreeWorkspaceFile: vi.fn(),
}))

const VIEW: groveApi.TreeWorkspaceView = {
  path: '.koala/workspace.json',
  file: { packages: { pip: ['cowsay'] } },
  composed: { lines: [{ what: 'dnf ripgrep', from: 'tool:count_lines' }, { what: 'pip cowsay', from: 'project' }], env: [] },
  published: { image: 'reg/ws:f1', commit: 'aaaabbbbcccc', publishedAt: '2026-10-12T10:00:00Z', lines: [{ what: 'dnf ripgrep', from: 'tool:count_lines' }], env: [] },
  pending: ['pip cowsay'],
  next: { runId: 'workspace-build-t1-dddddddddddd', stage: 'failed', text: 'not rebuilt: the build failed — pip: command not found', commit: 'dddddddddddd', at: 't' },
  builds: [{ runId: 'workspace-build-t1-dddddddddddd', outcome: 'failed', reason: 'pip: command not found', finishedAt: '2026-10-12T11:00:00Z', wallClockMs: 26000 }],
  can: { managers: ['dnf', 'apt', 'pip', 'npm'], languages: ['node', 'python', 'go'] },
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TreeWorkspaceFilePanel treeId="t1" />
    </QueryClientProvider>,
  )
}

describe('TreeWorkspaceFilePanel', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('shows every line with where it came from, what main adds, the next build\'s stage and the builds', async () => {
    vi.mocked(groveApi.getTreeWorkspaceFile).mockResolvedValue(VIEW)
    renderPanel()
    expect(await screen.findByText('pip cowsay')).toBeTruthy()
    expect(screen.getByText('from tool:count_lines')).toBeTruthy()
    expect(screen.getAllByText('on main, not built yet')).toHaveLength(1)
    expect(screen.getByTestId('workspace-next').textContent).toContain('pip: command not found')
    expect(screen.getByTestId('workspace-builds').textContent).toContain('26s')
  })

  it('commits an edit to main with what changed, and says it is being rebuilt', async () => {
    vi.mocked(groveApi.getTreeWorkspaceFile).mockResolvedValue(VIEW)
    vi.mocked(groveApi.saveTreeWorkspaceFile).mockResolvedValue({ ...VIEW, file: { packages: { pip: ['cowsay'], dnf: ['jq'] } }, committed: true })
    renderPanel()

    expect(screen.queryByText('Commit to main')).toBeNull()
    fireEvent.change(await screen.findByLabelText('dnf packages'), { target: { value: 'jq' } })
    fireEvent.change(screen.getByLabelText('what changed'), { target: { value: 'jq for the reports' } })
    fireEvent.click(screen.getByText('Commit to main'))

    await waitFor(() => expect(groveApi.saveTreeWorkspaceFile).toHaveBeenCalledWith('t1', { packages: { dnf: ['jq'], pip: ['cowsay'] } }, 'jq for the reports'))
    expect(await screen.findByText(/being rebuilt/)).toBeTruthy()
  })

  it('adds a dependency the project needs from the catalogue and commits it', async () => {
    vi.mocked(groveApi.getTreeWorkspaceFile).mockResolvedValue(VIEW)
    vi.mocked(groveApi.saveTreeWorkspaceFile).mockResolvedValue({ ...VIEW, file: { packages: { pip: ['cowsay'] }, needs: ['koala-e2e'] }, committed: true })
    renderPanel()

    const add = await screen.findByLabelText('Add to workspace dependencies')
    await waitFor(() => expect(within(add).getByRole('option', { name: /^koala-e2e/ })).toBeTruthy())
    fireEvent.change(add, { target: { value: 'koala-e2e' } })
    fireEvent.click(screen.getByText('Commit to main'))

    await waitFor(() => expect(groveApi.saveTreeWorkspaceFile).toHaveBeenCalledWith('t1', { packages: { pip: ['cowsay'] }, needs: ['koala-e2e'] }, undefined))
  })

  it('shows why a save was refused', async () => {
    vi.mocked(groveApi.getTreeWorkspaceFile).mockResolvedValue(VIEW)
    vi.mocked(groveApi.saveTreeWorkspaceFile).mockRejectedValue(Object.assign(new Error('Request failed'), { isAxiosError: true, response: { status: 400, data: { error: '"API_TOKEN" looks like a secret' } } }))
    renderPanel()
    fireEvent.click(await screen.findByText('add a value'))
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'API_TOKEN' } })
    fireEvent.click(screen.getByText('Commit to main'))
    expect(await screen.findByText(/looks like a secret/)).toBeTruthy()
  })
})
