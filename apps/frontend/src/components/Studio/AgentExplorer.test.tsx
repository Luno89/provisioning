import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AgentExplorer from './AgentExplorer'
import type { Agent } from '../../api/agents'

const params = vi.hoisted(() => ({ slug: undefined as string | undefined, part: undefined as string | undefined }))
const seen = vi.hoisted(() => ({ props: {} as Record<string, Record<string, unknown>> }))

vi.mock('@tanstack/react-router', () => ({
  useParams: () => params,
  useNavigate: () => vi.fn(),
  Link: ({ children, to, params: linked, className }: { children: React.ReactNode; to: string; params?: Record<string, string>; className?: string }) =>
    <a className={className} href={Object.entries(linked ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to)}>{children}</a>,
}))

const { stub } = vi.hoisted(() => ({
  stub: (name: string) => ({ default: (props: Record<string, unknown>) => { seen.props[name] = props; return <div data-testid={name} /> } }),
}))
vi.mock('./AgentFile', () => stub('file'))
vi.mock('./AgentEditor', () => stub('editor'))

const agent = (slug: string, usedBy: NonNullable<Agent['usedBy']>): Agent => ({
  slug, name: slug[0]!.toUpperCase() + slug.slice(1), description: '', version: '1', prompt: '', guidance: '', returns: '', failures: [],
  procedure: 'tool-rounds', tools: [], environment: {}, mine: false, usedBy,
})

vi.mock('./shared', () => ({
  errorMessage: (err: unknown) => String(err),
  useAgents: () => ({ isPending: false, isError: false, data: [
    agent('koala', [{ kind: 'chat', by: 'every new conversation' }]),
    agent('research', [{ kind: 'hand-off', by: 'koala' }]),
    agent('memory-keeper', [{ kind: 'platform', by: 'remembers' }]),
    agent('spare', []),
  ] }),
  useProcedureList: () => ({ data: { procedures: [{ id: 'tool-rounds' }], unreadable: [] } }),
}))
vi.mock('../Checks/shared', () => ({
  useScenarios: () => ({ data: [{ id: 's', name: 's', describe: '', agent: 'koala', procedure: { id: 'p' }, input: { message: 'x' }, expect: {} }] }),
  useLevel2Runs: () => ({ data: [{ id: 'r', state: 'done', startedAt: '2026-10-07', scenarios: ['s'], finished: 1, results: [{ scenarioId: 's', passed: false }] }] }),
  useProposals: () => ({ data: [{ status: 'proposed', scenario: { agent: 'koala' } }] }),
  useChanges: () => ({ data: [] }),
}))

beforeEach(() => {
  seen.props = {}
  params.slug = undefined
  params.part = undefined
})

const tree = () => within(screen.getByRole('complementary', { name: 'Agents' }))

describe('the agents explorer', () => {
  it('groups the agents by how they are used, and says what agents are when none is open', () => {
    render(<AgentExplorer />)
    expect(tree().getAllByRole('button').map((button) => button.textContent?.trim()).filter((text) => /^(You talk to|Run by|Handed|Not used)/.test(text ?? ''))).toEqual([
      'You talk to1', 'Run by the platform1', 'Handed work by other agents1', 'Not used yet1',
    ])
    expect(screen.getByText(/grouped by how they are used/)).toBeInTheDocument()
    expect(seen.props.file).toBeUndefined()
  })

  it('opens an agent at its overview, with its parts in the tree like files and what needs looking at marked', () => {
    params.slug = 'koala'
    render(<AgentExplorer />)
    expect(seen.props.file).toMatchObject({ agent: { slug: 'koala' }, file: 'overview' })
    expect(tree().getByText('Prompt').closest('a')).toHaveAttribute('href', '/studio/agents/koala/prompt')
    expect(tree().getByText('Checks').closest('a')).toHaveTextContent('1 ✕')
    expect(tree().getByText('Proposed changes').closest('a')).toHaveTextContent('1')
  })

  it('shows the part that was clicked, with the path to it above', () => {
    params.slug = 'koala'
    params.part = 'prompt'
    render(<AgentExplorer />)
    expect(seen.props.file).toMatchObject({ file: 'prompt' })
    expect(screen.getByRole('navigation', { name: 'Path' })).toHaveTextContent('AgentsKoalaPrompt')
  })

  it('finds an agent by name', async () => {
    render(<AgentExplorer />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Find in agents' }), 'memo')
    expect(tree().getByText('memory-keeper')).toBeInTheDocument()
    expect(tree().queryByText('koala')).toBeNull()
  })

  it('starts a new agent from a name', async () => {
    render(<AgentExplorer />)
    await userEvent.click(screen.getByRole('button', { name: 'New agent' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Name of the new agent' }), 'Digger Deluxe{Enter}')
    expect(seen.props.editor).toMatchObject({ agent: { slug: 'digger-deluxe', name: 'Digger Deluxe', mine: true } })
  })

  it('says so when there is no such agent or part', () => {
    params.slug = 'koala'
    params.part = 'nonsense'
    render(<AgentExplorer />)
    expect(screen.getByText('Koala has no part called “nonsense”.')).toBeInTheDocument()
  })
})
