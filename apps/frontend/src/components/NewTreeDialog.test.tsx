import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import NewTreeDialog from './NewTreeDialog.js'
import * as groveApi from '../api/grove.js'

vi.mock('../api/grove', async (importOriginal) => ({
  ...(await importOriginal<typeof groveApi>()),
  listTreeTypes: vi.fn(),
  createTree: vi.fn(),
  patchBranch: vi.fn(),
  patchTree: vi.fn(),
}))

const TYPES = [
  { id: 'type-1', label: 'Freeform project', summary: 'no assumptions', doneMeans: 'whatever the plan says', produces: 'service' },
]

function renderDialog(props: Partial<Parameters<typeof NewTreeDialog>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onClose = vi.fn()
  const onCreated = vi.fn()
  vi.mocked(groveApi.listTreeTypes).mockResolvedValue(TYPES as any)
  render(
    <QueryClientProvider client={qc}>
      <NewTreeDialog onClose={onClose} onCreated={onCreated} {...props} />
    </QueryClientProvider>,
  )
  return { onClose, onCreated }
}

describe('NewTreeDialog — plain creation', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('creates a tree with the picked type and calls onCreated with its id, no promotion calls', async () => {
    vi.mocked(groveApi.createTree).mockResolvedValue({ id: 'tree-1' } as any)
    const { onCreated } = renderDialog()

    fireEvent.change(screen.getByPlaceholderText('Koala API'), { target: { value: 'My Tree' } })
    fireEvent.click(await screen.findByText('Freeform project'))
    fireEvent.click(screen.getByRole('button', { name: /create/i }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('tree-1'))
    expect(groveApi.patchBranch).not.toHaveBeenCalled()
    expect(groveApi.patchTree).not.toHaveBeenCalled()
  });

  it('disables Create until a type is picked', async () => {
    renderDialog()
    await screen.findByText('Freeform project')
    expect(screen.getByRole('button', { name: /create/i })).toBeDisabled()
  });
});

describe('NewTreeDialog — promoting a tree-less branch', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('shows promotion copy and re-files the branch + links the project after creating the tree', async () => {
    vi.mocked(groveApi.createTree).mockResolvedValue({ id: 'tree-2' } as any)
    const { onCreated } = renderDialog({ promoteFromBranchId: 'branch-1', promoteToProjectId: 'proj-1' })

    expect(screen.getByText('Track as a typed tree')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('Koala API'), { target: { value: 'Promoted' } })
    fireEvent.click(await screen.findByText('Freeform project'))
    fireEvent.click(screen.getByRole('button', { name: /create/i }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('tree-2'))
    expect(groveApi.patchBranch).toHaveBeenCalledWith('branch-1', { treeId: 'tree-2' })
    expect(groveApi.patchTree).toHaveBeenCalledWith('tree-2', { projectId: 'proj-1' })
  });
});
