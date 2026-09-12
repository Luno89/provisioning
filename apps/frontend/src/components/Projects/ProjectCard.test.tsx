import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ProjectCard } from './ProjectCard.js'
import type { ProjectRow } from './shared.js'

describe('ProjectCard', () => {
  it('shows repo info and status badge for a tree with a linked project', () => {
    const row: ProjectRow = {
      id: 't1', name: 'widget',
      tree: { id: 't1', name: 'widget', branchCount: 2 },
      project: { id: 'p1', name: 'widget', giteaOwner: 'acme', giteaRepo: 'widget', status: 'running' },
    }
    render(<ProjectCard row={row} onOpen={vi.fn()} />)

    expect(screen.getByText('widget')).toBeInTheDocument()
    expect(screen.getByText('acme/widget')).toBeInTheDocument()
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('2 conversations')).toBeInTheDocument()
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
