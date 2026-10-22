import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ProjectCard } from './ProjectCard.js'
import type { ProjectRow } from '../shared.js'
vi.mock('./Strip/ProjectPulse.js', () => ({ ProjectPulse: ({ treeId, projectId }: { treeId?: string; projectId?: string }) => <span data-testid="project-pulse">{treeId ?? ''}{projectId ?? ''}</span> }))

describe('ProjectCard', () => {
  it('shows its status badge and what is going on, and its repository only when it is named differently', () => {
    const row: ProjectRow = {
      id: 't1', name: 'Delivery Labels',
      tree: { id: 't1', name: 'Delivery Labels', branchCount: 2 },
      project: { id: 'p1', name: 'Delivery Labels', giteaOwner: 'acme', giteaRepo: 'delivery-labels', status: 'running' },
    }
    const { unmount } = render(<ProjectCard row={row} onOpen={vi.fn()} />)
    expect(screen.getByText('Delivery Labels')).toBeInTheDocument()
    expect(screen.queryByText('delivery-labels')).toBeNull()
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByTestId('project-pulse')).toHaveTextContent('t1p1')
    unmount()

    render(<ProjectCard row={{ ...row, project: { ...row.project!, giteaRepo: 'shop-site' } }} onOpen={vi.fn()} />)
    expect(screen.getByText('shop-site')).toHaveAttribute('title', 'acme/shop-site')
  })

  it('marks a tree with no linked project as having no repository', () => {
    const row: ProjectRow = { id: 't1', name: 'widget', tree: { id: 't1', name: 'widget', branchCount: 0 } }
    render(<ProjectCard row={row} onOpen={vi.fn()} />)

    expect(screen.getByText('no repository yet')).toBeInTheDocument()
    expect(screen.queryByText('acme/widget')).not.toBeInTheDocument()
  })

  it('marks a project with no tree as having no conversation', () => {
    const row: ProjectRow = { id: 'p1', name: 'widget', project: { id: 'p1', name: 'widget', giteaOwner: 'acme', giteaRepo: 'widget' } }
    render(<ProjectCard row={row} onOpen={vi.fn()} />)

    expect(screen.getByText('no conversation yet')).toBeInTheDocument()
    expect(screen.queryByText(/conversations/)).not.toBeInTheDocument()
  })

  it('calls onOpen when clicked', () => {
    const onOpen = vi.fn()
    const row: ProjectRow = { id: 't1', name: 'widget', tree: { id: 't1', name: 'widget' } }
    render(<ProjectCard row={row} onOpen={onOpen} />)

    fireEvent.click(screen.getByRole('button'))
    expect(onOpen).toHaveBeenCalled()
  })

  it('badges a project whose leaves run on a local device, by name', () => {
    const row: ProjectRow = {
      id: 'p1', name: 'demo',
      project: {
        id: 'p1', name: 'demo', giteaOwner: 'acme', giteaRepo: 'demo',
        executionTarget: { kind: 'local-device', deviceId: 'dev-1' },
      },
    }
    render(<ProjectCard row={row} onOpen={vi.fn()} localAgents={[{ id: 'dev-1', name: 'My Laptop' }]} />)

    expect(screen.getByText((_, el) => el?.textContent === 'Local machine: My Laptop')).toBeInTheDocument()
  })

  it('badges a project that requires approval', () => {
    const row: ProjectRow = {
      id: 'p1', name: 'demo',
      project: {
        id: 'p1', name: 'demo', giteaOwner: 'acme', giteaRepo: 'demo',
        executionTarget: { kind: 'local-device', deviceId: 'dev-1' }, executionApproval: 'plan',
      },
    }
    render(<ProjectCard row={row} onOpen={vi.fn()} localAgents={[{ id: 'dev-1', name: 'My Laptop' }]} />)

    expect(screen.getByText(/approval required/i)).toBeInTheDocument()
  })

  it('does not badge approval-required for a project running in auto mode', () => {
    const row: ProjectRow = {
      id: 'p1', name: 'demo',
      project: {
        id: 'p1', name: 'demo', giteaOwner: 'acme', giteaRepo: 'demo',
        executionTarget: { kind: 'local-device', deviceId: 'dev-1' }, executionApproval: 'auto',
      },
    }
    render(<ProjectCard row={row} onOpen={vi.fn()} localAgents={[{ id: 'dev-1', name: 'My Laptop' }]} />)

    expect(screen.getByText((_, el) => el?.textContent === 'Local machine: My Laptop')).toBeInTheDocument()
    expect(screen.queryByText(/approval required/i)).not.toBeInTheDocument()
  })
})
