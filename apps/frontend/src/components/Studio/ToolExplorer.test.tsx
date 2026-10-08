import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ToolExplorer from './ToolExplorer'

const params = vi.hoisted(() => ({ name: undefined as string | undefined, part: undefined as string | undefined }))
const seen = vi.hoisted(() => ({ props: {} as Record<string, Record<string, unknown>> }))

vi.mock('@tanstack/react-router', () => ({
  useParams: () => params,
  useNavigate: () => vi.fn(),
  Link: ({ children, to, params: linked }: { children: React.ReactNode; to: string; params?: Record<string, string> }) =>
    <a href={Object.entries(linked ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to)}>{children}</a>,
}))

const { stub } = vi.hoisted(() => ({
  stub: (name: string) => ({ default: (props: Record<string, unknown>) => { seen.props[name] = props; return <div data-testid={name} /> } }),
}))
vi.mock('./ToolEditor', () => stub('editor'))
vi.mock('./McpToolKinds', () => stub('mcp'))
vi.mock('../Checks/CheckList', () => stub('checks'))
vi.mock('../Checks/Coverage', () => stub('coverage'))
vi.mock('../Checks/shared', () => ({ useScenarios: () => ({ data: [] }), useLevel2Runs: () => ({ data: [] }) }))

const tool = (name: string, binding: string, effect: string, grantedTo: string[] = []) => ({ name, summary: `${name} does it`, binding, effect, grantedTo, mine: false })
vi.mock('./shared', () => ({
  errorMessage: (err: unknown) => String(err),
  useEngineTools: () => ({ isPending: false, isError: false, data: [
    tool('write_file', 'environment', 'write', ['koala', 'executor']), tool('get_logs', 'platform', 'read'), tool('propose_plan', 'platform', 'propose'), tool('fetch_web_page', 'network', 'read'),
  ] }),
  useAgents: () => ({ data: [{ slug: 'koala' }, { slug: 'executor' }] }),
  useProcedureList: () => ({ data: { procedures: [], unreadable: [] } }),
}))

beforeEach(() => {
  seen.props = {}
  params.name = undefined
  params.part = undefined
})

const tree = () => within(screen.getByRole('complementary', { name: 'Tools' }))

describe('the tools explorer', () => {
  it('groups tools by what they act on and how far they go', () => {
    render(<ToolExplorer />)
    for (const title of ['Work in the workspace', 'Reach the web', 'Look things up', 'Propose and ask you']) expect(tree().getByText(title)).toBeInTheDocument()
    expect(tree().queryByText('Change things on the platform')).toBeNull()
  })

  it('opens a tool on who holds it, and each part on its own', () => {
    params.name = 'write_file'
    render(<ToolExplorer />)
    expect(screen.getByText('executor', { selector: 'a' })).toHaveAttribute('href', '/studio/agents/executor')

    params.part = 'definition'
    render(<ToolExplorer />)
    expect(seen.props.editor).toMatchObject({ tool: { name: 'write_file' } })

    params.part = 'checks'
    render(<ToolExplorer />)
    expect(seen.props.checks).toMatchObject({ scope: { tool: 'write_file' }, agents: ['koala', 'executor'] })
  })

  it('starts a new tool from a name, in the shape a tool has to have', async () => {
    render(<ToolExplorer />)
    await userEvent.click(screen.getByRole('button', { name: 'New tool' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Name of the new tool' }), 'Count Words{Enter}')
    expect(seen.props.editor).toMatchObject({ tool: { name: 'count_words', mine: true } })
  })
})
