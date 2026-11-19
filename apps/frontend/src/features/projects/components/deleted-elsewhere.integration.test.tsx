import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { TreeAutoMode } from './Settings'
import { TreeModels } from './Workspace/TreeModels'
import { TreeDeletePanel } from './Workspace/TreeDeletePanel'
import { FeatureDelete } from './Board/FeatureDelete'
import { StoryTasks } from './Board/StoryTasks'
import { createTree, deleteBranch, deleteLeaf, deleteTree } from '../api/grove'
import { listTasks } from '../../engine'
import { startBackend } from '../../../test/backend/site'
import { projectsOf } from '../../../test/backend/projects'
import { mountEngine } from '../../../test/backend/engine'
import { shown } from '../../../test/backend/hooks'

const backend = await startBackend(async (site) => {
  await projectsOf(site)
  mountEngine(site)
})
const owner = await backend.signIn()
const now = new Date().toISOString()

const opened = (part: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{part}</QueryClientProvider>)

const aTree = async (name: string): Promise<string> => (await createTree<{ id: string }>({ name, type: 'research-paper' })).id

describe('a tree\'s settings and board, when what they show was deleted in another tab', () => {
  it('says the tree\'s models cannot be read once the tree is gone', async () => {
    const treeId = await aTree('Gone before opening')
    await deleteTree(treeId)
    const page = opened(<TreeModels treeId={treeId} />)
    expect((await shown(() => screen.queryByRole('alert'))).textContent).toBe('Could not read the tree\'s models: Tree not found')
    page.unmount()
  })

  it('says a model choice was not saved once the tree is gone', async () => {
    const treeId = await aTree('Choosing its models')
    const page = opened(<TreeModels treeId={treeId} />)
    const [change] = await shown(() => { const found = screen.queryAllByRole('button', { name: 'Change' }); return found.length ? found : null })
    await deleteTree(treeId)
    await userEvent.click(change!)
    await userEvent.click(screen.getByRole('button', { name: /^Its own/ }))
    const refused = await shown(() => screen.queryByRole('alert'))
    expect(refused.textContent).toBe('Tree not found')
    expect(refused.closest('[data-testid="tree-model-row"]')).not.toBeNull()
    page.unmount()
  })

  it('says why auto mode could not be switched on once the tree is gone', async () => {
    const treeId = await aTree('Switching auto mode')
    const page = opened(<TreeAutoMode treeId={treeId} />)
    const auto = await shown(() => { const box = screen.queryByRole<HTMLInputElement>('checkbox', { name: 'Auto mode' }); return box && !box.disabled ? box : null })
    await deleteTree(treeId)
    await userEvent.click(auto)
    const refused = await shown(() => screen.queryByRole('alert'))
    expect(refused.textContent).toBe('Tree not found')
    expect(refused.closest('[data-testid="auto-mode"]')).not.toBeNull()
    page.unmount()
  })

  it('says the tree could not be deleted once it was deleted elsewhere, and stays', async () => {
    const treeId = await aTree('Deleted twice')
    let left = false
    const page = opened(<TreeDeletePanel treeId={treeId} treeName="Deleted twice" onDeleted={() => { left = true }} />)
    await userEvent.click(screen.getByRole('button', { name: /Delete this tree/ }))
    await deleteTree(treeId)
    await userEvent.click(screen.getByRole('button', { name: 'Delete tree' }))
    expect((await shown(() => screen.queryByRole('alert'))).textContent).toBe('The tree could not be deleted: Tree not found')
    expect(left).toBe(false)
    page.unmount()
  })

  it('says a feature could not be deleted once it was deleted elsewhere', async () => {
    const treeId = await aTree('With a feature')
    await backend.db.projects.saveBranch({ id: 'feature-gone', ownerId: owner.id, treeId, title: 'Feature', createdAt: now, updatedAt: now })
    let left = false
    const page = opened(<FeatureDelete branchId="feature-gone" title="Feature" onDeleted={() => { left = true }} />)
    await userEvent.click(screen.getByRole('button', { name: /Delete this feature/ }))
    await deleteBranch('feature-gone')
    await userEvent.click(screen.getByRole('button', { name: 'Delete feature' }))
    expect((await shown(() => screen.queryByRole('alert'))).textContent).toBe('Branch not found')
    expect(left).toBe(false)
    page.unmount()
  })

  it('says a proposed task could not be accepted once its story was deleted', async () => {
    const treeId = await aTree('With a story')
    await backend.db.projects.saveBranch({ id: 'feature-of-story', ownerId: owner.id, treeId, title: 'Feature', createdAt: now, updatedAt: now })
    await backend.db.projects.saveLeaf({ id: 'story-gone', ownerId: owner.id, branchId: 'feature-of-story', title: 'Story', status: 'pending', createdAt: now, updatedAt: now })
    await backend.db.projects.saveTask({ id: 'task-of-story', ownerId: owner.id, leafId: 'story-gone', title: 'Measure the GPU', doneMeans: 'a number', dependsOn: [], status: 'proposed', runs: [], createdAt: now, updatedAt: now })
    const tasks = (await listTasks()).filter((task) => task.id === 'task-of-story')
    const page = opened(<StoryTasks tasks={tasks} />)
    await deleteLeaf('story-gone')
    await userEvent.click(screen.getByRole('button', { name: 'Accept “Measure the GPU”' }))
    expect((await shown(() => screen.queryByRole('alert'))).textContent).toBe('No such task')
    page.unmount()
  })
})
