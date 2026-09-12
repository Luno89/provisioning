import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi } from 'vitest'
import { Workspace } from './index.js'
import * as groveApi from '../../../api/grove.js'
import * as projectsApi from '../../../api/projects.js'
import * as packsApi from '../../../api/packs.js'

vi.mock('../../../api/grove.js', async (importOriginal) => ({
  ...(await importOriginal<typeof groveApi>()),
  listTrees: vi.fn(),
  listBranches: vi.fn(),
  listLeaves: vi.fn(),
  createBranch: vi.fn(),
}))
vi.mock('../../../api/projects.js', async (importOriginal) => ({
  ...(await importOriginal<typeof projectsApi>()),
  listProjects: vi.fn(),
}))
vi.mock('../../../api/packs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof packsApi>()),
  listPacks: vi.fn(async () => []),
}))

vi.mock('../../Home.js', () => ({ default: () => <div data-testid="home">home</div> }))
vi.mock('../../BranchChat.js', () => ({ default: () => <div data-testid="branch-chat">branch-chat</div> }))
vi.mock('../../LeafDetail.js', () => ({ default: () => <div data-testid="leaf-detail">leaf-detail</div> }))
vi.mock('../../NewTreeDialog.js', () => ({ default: () => <div data-testid="new-tree-dialog">new-tree-dialog</div> }))
vi.mock('../../ProjectEditor/FileTree.js', () => ({ FileTree: () => <div data-testid="file-tree">file-tree</div> }))
vi.mock('../../ProjectEditor/EditorPane.js', () => ({ EditorPane: () => <div data-testid="editor-pane">editor-pane</div> }))
vi.mock('../../ProjectEditor/TabBar.js', () => ({ TabBar: () => <div data-testid="tab-bar">tab-bar</div> }))
vi.mock('./BuildsDeploysPanel.js', () => ({ BuildsDeploysPanel: () => <div data-testid="builds-panel">builds-panel</div> }))
vi.mock('./BranchesPanel.js', () => ({
  BranchesPanel: ({ onSelectBranch, onSelectLeaf }: { onSelectBranch: (id: string) => void; onSelectLeaf: (id: string) => void }) => (
    <div data-testid="branches-panel">
      <button onClick={() => onSelectBranch('b1')}>select-branch</button>
      <button onClick={() => onSelectLeaf('l1')}>select-leaf</button>
    </div>
  ),
}))

function renderWorkspace(props: Partial<Parameters<typeof Workspace>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <Workspace {...props} />
    </QueryClientProvider>,
  )
}

const treeWithProject = { id: 't1', name: 'widget', projectIds: ['p1'] }
const treeNoProject = { id: 't1', name: 'widget', projectIds: [] }
const project = { id: 'p1', name: 'widget', giteaOwner: 'acme', giteaRepo: 'widget' }

describe('Workspace layout', () => {
  it('shows the file tree, editor, and builds panel when the tree has a linked project', async () => {
    vi.mocked(groveApi.listTrees).mockResolvedValue([treeWithProject] as never)
    vi.mocked(groveApi.listBranches).mockResolvedValue([])
    vi.mocked(groveApi.listLeaves).mockResolvedValue([])
    vi.mocked(projectsApi.listProjects).mockResolvedValue([project])

    renderWorkspace({ treeId: 't1' })

    expect(await screen.findByTestId('file-tree')).toBeInTheDocument()
    expect(screen.getByTestId('builds-panel')).toBeInTheDocument()
    expect(screen.getByTestId('home')).toBeInTheDocument()
    expect(screen.getByTestId('branches-panel')).toBeInTheDocument()
  })

  it('hides the file tree, editor, and builds panel when the tree has no linked project', async () => {
    vi.mocked(groveApi.listTrees).mockResolvedValue([treeNoProject] as never)
    vi.mocked(groveApi.listBranches).mockResolvedValue([])
    vi.mocked(groveApi.listLeaves).mockResolvedValue([])
    vi.mocked(projectsApi.listProjects).mockResolvedValue([])

    renderWorkspace({ treeId: 't1' })

    await waitFor(() => expect(screen.getByTestId('home')).toBeInTheDocument())
    expect(screen.queryByTestId('file-tree')).not.toBeInTheDocument()
    expect(screen.queryByTestId('builds-panel')).not.toBeInTheDocument()
  })

  it('offers to start a conversation for a project with no tree, and shows the editor pieces anyway', async () => {
    vi.mocked(groveApi.listTrees).mockResolvedValue([])
    vi.mocked(groveApi.listBranches).mockResolvedValue([])
    vi.mocked(groveApi.listLeaves).mockResolvedValue([])
    vi.mocked(projectsApi.listProjects).mockResolvedValue([project])

    renderWorkspace({ projectId: 'p1' })

    expect(await screen.findByText('Start a conversation')).toBeInTheDocument()
    expect(await screen.findByTestId('file-tree')).toBeInTheDocument()
    expect(screen.queryByTestId('home')).not.toBeInTheDocument()
    expect(screen.queryByTestId('branches-panel')).not.toBeInTheDocument()
  })

  it('clicking "Start a conversation" creates a tree-less branch scoped to the project directly, no dialog', async () => {
    vi.mocked(groveApi.listTrees).mockResolvedValue([])
    vi.mocked(groveApi.listBranches).mockResolvedValue([])
    vi.mocked(groveApi.listLeaves).mockResolvedValue([])
    vi.mocked(projectsApi.listProjects).mockResolvedValue([project])
    vi.mocked(groveApi.createBranch).mockResolvedValue({ id: 'b-new', title: 'New branch', messages: [], projectId: 'p1', updatedAt: '' } as never)

    renderWorkspace({ projectId: 'p1' })

    await screen.findByTestId('file-tree')
    const startBtn = screen.getByText('Start a conversation')
    fireEvent.click(startBtn)

    await waitFor(() => expect(groveApi.createBranch).toHaveBeenCalledWith({ projectId: 'p1' }))
    expect(screen.queryByTestId('new-tree-dialog')).not.toBeInTheDocument()
    expect(await screen.findByTestId('branch-chat')).toBeInTheDocument()
  })

  it('swaps the right column to BranchChat when a branch is selected, and to LeafDetail when a leaf is selected', async () => {
    vi.mocked(groveApi.listTrees).mockResolvedValue([treeWithProject] as never)
    vi.mocked(groveApi.listBranches).mockResolvedValue([{ id: 'b1', title: 'demo', treeId: 't1', messages: [], updatedAt: '' } as never])
    vi.mocked(groveApi.listLeaves).mockResolvedValue([{ id: 'l1', branchId: 'b1', title: 'a leaf' } as never])
    vi.mocked(projectsApi.listProjects).mockResolvedValue([project])

    renderWorkspace({ treeId: 't1' })
    await screen.findByTestId('home')

    fireEvent.click(screen.getByText('select-branch'))
    expect(await screen.findByTestId('branch-chat')).toBeInTheDocument()

    // Branches panel collapses when branch is selected, expand it to select leaf
    fireEvent.click(screen.getByText('Branches'))
    fireEvent.click(screen.getByText('select-leaf'))
    expect(await screen.findByTestId('leaf-detail')).toBeInTheDocument()
  })

  it('collapses branches when a branch is selected so chat takes precedence', async () => {
    vi.mocked(groveApi.listTrees).mockResolvedValue([treeWithProject] as never)
    vi.mocked(groveApi.listBranches).mockResolvedValue([{ id: 'b1', title: 'demo', treeId: 't1', messages: [], updatedAt: '' } as never])
    vi.mocked(groveApi.listLeaves).mockResolvedValue([])
    vi.mocked(projectsApi.listProjects).mockResolvedValue([project])

    renderWorkspace({ treeId: 't1' })
    expect(await screen.findByTestId('home')).toBeInTheDocument()
    expect(screen.getByTestId('branches-panel')).toBeInTheDocument()

    // Click branch
    fireEvent.click(screen.getByText('select-branch'))

    // Chat is now visible and branches panel is collapsed
    expect(await screen.findByTestId('branch-chat')).toBeInTheDocument()
    expect(screen.queryByTestId('branches-panel')).not.toBeInTheDocument()
  })

  it('collapses and expands the left explorer panel when the collapse button is clicked', async () => {
    vi.mocked(groveApi.listTrees).mockResolvedValue([treeWithProject] as never)
    vi.mocked(groveApi.listBranches).mockResolvedValue([])
    vi.mocked(groveApi.listLeaves).mockResolvedValue([])
    vi.mocked(projectsApi.listProjects).mockResolvedValue([project])

    renderWorkspace({ treeId: 't1' })
    expect(await screen.findByTestId('file-tree')).toBeInTheDocument()

    // Collapse left panel
    const collapseLeftBtn = screen.getByLabelText('Collapse left panel')
    fireEvent.click(collapseLeftBtn)

    expect(screen.queryByTestId('file-tree')).not.toBeInTheDocument()
    expect(screen.getByTestId('left-panel-collapsed')).toBeInTheDocument()

    // Expand left panel
    const expandLeftBtn = screen.getAllByLabelText('Expand left panel')[0]!
    fireEvent.click(expandLeftBtn)

    expect(await screen.findByTestId('file-tree')).toBeInTheDocument()
    expect(screen.queryByTestId('left-panel-collapsed')).not.toBeInTheDocument()
  })

  it('collapses and expands the right conversation panel when the collapse button is clicked', async () => {
    vi.mocked(groveApi.listTrees).mockResolvedValue([treeWithProject] as never)
    vi.mocked(groveApi.listBranches).mockResolvedValue([])
    vi.mocked(groveApi.listLeaves).mockResolvedValue([])
    vi.mocked(projectsApi.listProjects).mockResolvedValue([project])

    renderWorkspace({ treeId: 't1' })
    expect(await screen.findByTestId('home')).toBeInTheDocument()

    // Collapse right panel
    const collapseRightBtn = screen.getByLabelText('Collapse right panel')
    fireEvent.click(collapseRightBtn)

    expect(screen.queryByTestId('home')).not.toBeInTheDocument()
    expect(screen.getByTestId('right-panel-collapsed')).toBeInTheDocument()

    // Expand right panel
    const expandRightBtn = screen.getAllByLabelText('Expand right panel')[0]!
    fireEvent.click(expandRightBtn)

    expect(await screen.findByTestId('home')).toBeInTheDocument()
    expect(screen.queryByTestId('right-panel-collapsed')).not.toBeInTheDocument()
  })

  it('toggles collapse when double-clicking the resize separators', async () => {
    vi.mocked(groveApi.listTrees).mockResolvedValue([treeWithProject] as never)
    vi.mocked(groveApi.listBranches).mockResolvedValue([])
    vi.mocked(groveApi.listLeaves).mockResolvedValue([])
    vi.mocked(projectsApi.listProjects).mockResolvedValue([project])

    renderWorkspace({ treeId: 't1' })
    expect(await screen.findByTestId('file-tree')).toBeInTheDocument()

    // Double click left separator
    const leftSeparator = screen.getByLabelText('Resize file panel')
    fireEvent.doubleClick(leftSeparator)
    expect(screen.queryByTestId('file-tree')).not.toBeInTheDocument()
    expect(screen.getByTestId('left-panel-collapsed')).toBeInTheDocument()

    // Double click right separator
    const rightSeparator = screen.getByLabelText('Resize conversation panel')
    fireEvent.doubleClick(rightSeparator)
    expect(screen.queryByTestId('home')).not.toBeInTheDocument()
    expect(screen.getByTestId('right-panel-collapsed')).toBeInTheDocument()
  })
})

