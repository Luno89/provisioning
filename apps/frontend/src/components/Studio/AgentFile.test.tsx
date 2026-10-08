import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import AgentFile from './AgentFile'
import type { Agent } from '../../api/agents'

const seen = vi.hoisted(() => ({ props: {} as Record<string, Record<string, unknown>> }))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children, to, params }: { children: React.ReactNode; to: string; params?: Record<string, string> }) =>
    <a href={Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to)}>{children}</a>,
}))

const { stub } = vi.hoisted(() => ({
  stub: (name: string) => ({ default: (props: Record<string, unknown>) => { seen.props[name] = props; return <div data-testid={name} /> } }),
}))
vi.mock('./AgentEditor', () => stub('editor'))
vi.mock('./AgentTryIt', () => stub('try'))
vi.mock('../Memories', () => stub('memories'))
vi.mock('../Checks/CheckList', () => stub('checks'))
vi.mock('../Checks/Coverage', () => stub('coverage'))
vi.mock('../Checks/ComparePanel', () => stub('compare'))
vi.mock('../Checks/PracticesPanel', () => stub('practices'))
vi.mock('../Checks/ProposalsPanel', () => stub('proposals'))
vi.mock('../Checks/ChangesPanel', () => stub('changes'))
vi.mock('../Checks/shared', () => ({
  useScenarios: () => ({ data: [] }),
  useLevel2Runs: () => ({ data: [] }),
  usePractices: () => ({ data: [] }),
  useProposals: () => ({ data: [] }),
  useChanges: () => ({ data: [] }),
}))
vi.mock('./shared', () => ({
  useAgents: () => ({ data: [{ slug: 'research', recallsMemories: true }, { slug: 'koala', recallsMemories: true }] }),
  useEngineAgents: () => ({ data: [] }),
  useProcedureList: () => ({ data: { procedures: [], unreadable: [] } }),
}))

const agent = (over: Partial<Agent> = {}): Agent => ({
  slug: 'research', name: 'Research', description: 'Looks things up', version: '1', prompt: '', guidance: '', returns: '', failures: [],
  procedure: 'research-loop', tools: ['read_file'], agents: [], environment: {}, mine: false, recallsMemories: true,
  usedBy: [{ kind: 'hand-off', by: 'koala' }, { kind: 'procedure', by: 'delivery' }], ...over,
})

beforeEach(() => { seen.props = {} })

describe('a part of an agent, opened like a file', () => {
  it('opens on how the agent is used and a line per part, each opening that part', () => {
    render(<AgentFile agent={agent()} file="overview" />)
    expect(screen.getByText('handed work by koala')).toBeInTheDocument()
    expect(screen.getByText('run by the delivery procedure')).toBeInTheDocument()
    expect(screen.getByText('runs research-loop').closest('a')).toHaveAttribute('href', '/studio/agents/research/procedure')
    expect(screen.getByText('no checks yet')).toBeInTheDocument()
  })

  it('says when nothing uses it', () => {
    render(<AgentFile agent={agent({ usedBy: [] })} file="overview" />)
    expect(screen.getByText(/Nothing uses it yet/)).toBeInTheDocument()
  })

  it('opens just that part of its definition in the editor', () => {
    render(<AgentFile agent={agent()} file="tools" />)
    expect(seen.props.editor).toMatchObject({ only: 'tools', agent: { slug: 'research' } })
  })

  it('opens its memories, checks and coverage scoped to it, with the tools it holds and its runs to compare', () => {
    render(<AgentFile agent={agent()} file="memories" />)
    expect(seen.props.memories).toMatchObject({ sharedWith: ['koala'] })
    render(<AgentFile agent={agent()} file="checks" />)
    expect(seen.props.checks).toMatchObject({ scope: { agent: 'research' } })
    render(<AgentFile agent={agent()} file="coverage" />)
    expect(seen.props.coverage).toMatchObject({ scope: { agent: 'research', heldTools: ['read_file'] } })
    expect(seen.props.compare).toMatchObject({ scope: { agent: 'research' } })
  })

  it('says an agent that recalls nothing sees only its practices', () => {
    render(<AgentFile agent={agent({ recallsMemories: false })} file="memories" />)
    expect(seen.props.memories).toBeUndefined()
    expect(screen.getByText(/Research recalls no memories/)).toBeInTheDocument()
  })
})
