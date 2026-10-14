import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import AgentEditor, { type AgentSection } from './AgentEditor'
import { blankAgent, toolProblem } from './agent-forms'
import type { Agent, GrantableTool } from '../../api/agents'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({ children, to, params }: { children: React.ReactNode; to: string; params?: Record<string, string> }) =>
    <a href={Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to)}>{children}</a>,
}))

vi.mock('../../api/agents', async () => {
  const actual = await vi.importActual<typeof import('../../api/agents')>('../../api/agents')
  return {
    ...actual,
    listAgents: vi.fn(),
    listGrantableTools: vi.fn(),
    saveAgent: vi.fn(),
    deleteAgent: vi.fn(async () => undefined),
  }
})

vi.mock('../../api/mcp', async () => {
  const actual = await vi.importActual<typeof import('../../api/mcp')>('../../api/mcp')
  return {
    ...actual,
    getMcpCatalogue: vi.fn(async () => ({
      servers: [{ id: 'p1', name: 'playwright', runs: { where: 'workspace', install: [{ via: 'npm', packages: ['@playwright/mcp'] }], start: 'playwright-mcp', port: 8931 }, status: { state: 'captured', tools: 23 }, createdAt: 't', updatedAt: 't' }],
      templates: [],
    })),
  }
})

vi.mock('../../api/procedures', async () => {
  const actual = await vi.importActual<typeof import('../../api/procedures')>('../../api/procedures')
  return {
    ...actual,
    listProcedures: vi.fn(async () => ({
      procedures: [
        { id: 'tool-rounds', version: '2', name: 'Tool rounds', describe: '', mine: false, requires: [] },
        {
          id: 'do-one-task',
          version: '2',
          name: 'Do one task',
          describe: '',
          mine: false,
          requires: [
            { name: 'mark_done', kind: 'tool', node: 'record', why: 'The outcome is recorded for you.' },
            { name: 'judge', kind: 'agent', node: 'judge', why: 'A judge weighs your work.' },
          ],
        },
      ],
      unreadable: [],
    })),
  }
})

vi.mock('../../api/auto-mode', async () => ({
  ...(await vi.importActual<typeof import('../../api/auto-mode')>('../../api/auto-mode')),
  listAutoModeAgents: vi.fn(async () => ['koala']),
  setAgentAutoMode: vi.fn(async (slug: string, on: boolean) => (on ? ['executor', 'koala'] : ['koala'])),
}))

const { listAgents, listGrantableTools, saveAgent, deleteAgent } = await import('../../api/agents')
const { setAgentAutoMode } = await import('../../api/auto-mode')

const TOOLS: GrantableTool[] = [
  { name: 'read_file', summary: 'Read a file', binding: 'environment', effect: 'read', needs: ['filesystem'] },
  { name: 'search_web', summary: 'Search the web', binding: 'network', effect: 'read', needs: [] },
  { name: 'mark_done', summary: 'Finish a task', binding: 'platform', effect: 'write', needs: [] },
]

const agent = (over: Partial<Agent> = {}): Agent => ({
  slug: 'executor',
  name: 'Executor',
  description: 'Does one task',
  version: '1',
  prompt: 'You do one thing.',
  guidance: '',
  returns: '',
  failures: [],
  procedure: 'do-one-task',
  tools: ['read_file'],
  toolSources: [{ tool: 'read_file', source: 'shipped' }],
  environment: { terminal: true, filesystem: true },
  mine: false,
  image: { state: 'ready', reference: 'registry/koala:abc' },
  ...over,
})


const edit = async (slug: string, only?: AgentSection) => {
  const all = await listAgents()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const shown = render(<QueryClientProvider client={client}><AgentEditor agent={all.find((one) => one.slug === slug)!} agents={all} only={only} /></QueryClientProvider>)
  if (!only) {
    await screen.findByRole('button', { name: 'Add tools' })
    await screen.findByRole('option', { name: 'do-one-task' })
  }
  return shown
}

beforeEach(() => {
  vi.clearAllMocks()
  const koala = agent({ slug: 'koala', name: 'Koala', tools: [], environment: {}, mine: true })
  delete koala.image
  vi.mocked(listAgents).mockResolvedValue([agent(), koala])
  vi.mocked(listGrantableTools).mockResolvedValue({ tools: TOOLS, languages: ['node', 'python', 'go'] })
})

describe('editing an agent', () => {

  it('puts a built-in agent in auto mode at once, without saving a copy of it', async () => {
    await edit('executor', 'settings')

    const box = await screen.findByLabelText('Auto mode')
    await waitFor(() => expect(box).toBeEnabled())
    expect(box).not.toBeChecked()
    await userEvent.click(box)

    await waitFor(() => expect(setAgentAutoMode).toHaveBeenCalledWith('executor', true))
    await waitFor(() => expect(screen.getByLabelText('Auto mode')).toBeChecked())
    expect(saveAgent).not.toHaveBeenCalled()
  })

  it('keeps a built-in built in while only its tools change, and offers your own copy once anything else does', async () => {
    await edit('executor')

    expect(screen.getByText(/changing only its tools keeps it built in/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete my copy' })).not.toBeInTheDocument()

    await userEvent.type(screen.getByDisplayValue('You do one thing.'), ' Carefully.')
    expect(screen.getByText(/Your own copy of Executor/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save as my own' })).toBeInTheDocument()
  })

  it('says which tools are built in and which you granted, and gives back a built-in one taken away', async () => {
    vi.mocked(listAgents).mockResolvedValue([agent({
      tools: ['read_file', 'search_web'],
      toolSources: [{ tool: 'read_file', source: 'shipped' }, { tool: 'mark_done', source: 'revoked' }, { tool: 'search_web', source: 'granted' }],
    })])
    await edit('executor')
    const held = within(screen.getByRole('region', { name: 'Tools it holds' }))
    expect(held.getByText('read_file').closest('div')).toHaveTextContent('built in')
    expect(held.getByText('search_web').closest('div')).toHaveTextContent('granted by you')
    expect(held.getByText('Built in, taken away by you')).toBeInTheDocument()

    await userEvent.click(held.getByRole('button', { name: 'Give back mark_done' }))
    expect(held.queryByText('Built in, taken away by you')).toBeNull()
    expect(held.getByText('mark_done').closest('div')).toHaveTextContent('built in')
  })

  it('lists the tools it holds, grouped, and offers the rest to add', async () => {
    await edit('executor')
    const held = within(screen.getByRole('region', { name: 'Tools it holds' }))
    expect(held.getByText('Work in the workspace')).toBeInTheDocument()
    expect(held.getByText('read_file').closest('a')).toHaveAttribute('href', '/studio/tools/read_file')
    expect(held.queryByText('search_web')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Add tools' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Find a tool to add' }), 'web')
    const offered = within(screen.getByRole('region', { name: 'Tools it could be given' }))
    expect(offered.queryByText('mark_done')).toBeNull()
    expect(offered.getByText('search_web')).toBeInTheDocument()
  })

  it('saves the tools it was given and the ones taken away', async () => {
    vi.mocked(saveAgent).mockResolvedValue(agent({ mine: true, tools: ['search_web'] }))
    await edit('executor')
    await userEvent.click(screen.getByRole('button', { name: 'Add tools' }))
    await userEvent.click(screen.getByRole('button', { name: 'Add search_web' }))
    await userEvent.click(screen.getByRole('button', { name: 'Take away read_file' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(saveAgent).toHaveBeenCalledWith(expect.objectContaining({
      slug: 'executor',
      tools: ['search_web'],
    })))
  })

  it('names a granted tool the catalogue no longer has, so it can be taken away', async () => {
    vi.mocked(listAgents).mockResolvedValue([agent({ tools: ['read_file', 'gone_tool'] })])
    await edit('executor')
    expect(screen.getByText('No longer in the catalogue')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Take away gone_tool' }))
    expect(screen.queryByText('gone_tool')).toBeNull()
  })

  it('saves how many quiet minutes conclude a conversation', async () => {
    vi.mocked(saveAgent).mockResolvedValue(agent({ mine: true }))
    await edit('executor')
    const minutes = screen.getByRole('textbox', { name: 'Quiet minutes before a conversation concludes' })
    await userEvent.type(minutes, '25')
    await userEvent.click(screen.getByRole('button', { name: 'Save as my own' }))
    await waitFor(() => expect(saveAgent).toHaveBeenCalledWith(expect.objectContaining({ concludeAfterMinutes: 25 })))
  })

  it('drops the quiet minutes when cleared, so the default applies', async () => {
    vi.mocked(listAgents).mockResolvedValue([agent({ concludeAfterMinutes: 25 })])
    vi.mocked(saveAgent).mockResolvedValue(agent({ mine: true }))
    await edit('executor')
    await userEvent.clear(screen.getByRole('textbox', { name: 'Quiet minutes before a conversation concludes' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save as my own' }))

    await waitFor(() => expect(saveAgent).toHaveBeenCalled())
    expect(vi.mocked(saveAgent).mock.calls[0]![0]).not.toHaveProperty('concludeAfterMinutes')
  })

  it('only offers to delete an agent of your own', async () => {
    await edit('koala')
    await userEvent.click(screen.getByRole('button', { name: 'Delete my copy' }))

    await waitFor(() => expect(deleteAgent).toHaveBeenCalledWith('koala'))
  })

})

describe('what a blank agent starts as', () => {
  it('runs the procedure it was given, grants nothing, and is yours', () => {
    expect(blankAgent('tool-rounds')).toMatchObject({ procedure: 'tool-rounds', tools: [], mine: true, environment: {} })
  })
})

describe('warning about a tool the workspace cannot run', () => {
  it('says what the workspace is missing', () => {
    expect(toolProblem(TOOLS[0]!, {})).toBe('needs files')
    expect(toolProblem(TOOLS[0]!, { filesystem: true })).toBeUndefined()
  })

  it('says nothing about a tool that needs nothing of the workspace', () => {
    expect(toolProblem(TOOLS[1]!, {})).toBeUndefined()
  })
})

describe('the languages a workspace can ask for', () => {
  it('names them, and says the rest are installed', async () => {
    await edit('executor')

    expect(screen.getByText(/A workspace can ask for node, python, go/)).toBeInTheDocument()
  })
})

describe('the grants a procedure requires', () => {
  it('says what they are and why, and will not let you turn one off', async () => {
    vi.mocked(listAgents).mockResolvedValue([agent({ procedure: 'do-one-task', tools: ['read_file', 'mark_done'], agents: ['judge'], mine: true })])
    await edit('executor')

    expect(screen.getByText('What do-one-task needs')).toBeInTheDocument()
    expect(screen.getByText('The outcome is recorded for you.', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('do-one-task needs it')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Take away mark_done' })).toBeNull()
  })

  it('ticks what the procedure needs when you switch to it', async () => {
    vi.mocked(saveAgent).mockResolvedValue(agent({ mine: true }))
    await edit('executor')
    await userEvent.selectOptions(screen.getByLabelText('Procedure it runs'), 'do-one-task')
    await userEvent.click(screen.getByRole('button', { name: /Save/ }))

    await waitFor(() => expect(saveAgent).toHaveBeenCalledWith(expect.objectContaining({
      procedure: 'do-one-task',
      tools: expect.arrayContaining(['mark_done']),
      agents: expect.arrayContaining(['judge']),
    })))
  })
})

describe('one part of an agent, opened on its own', () => {
  it('shows only that part, and saves the whole agent with that part changed', async () => {
    vi.mocked(saveAgent).mockResolvedValue(agent({ mine: true }))
    await edit('executor', 'prompt')

    expect(screen.getByText('Prompt')).toBeInTheDocument()
    expect(screen.queryByText('Tools it is granted')).toBeNull()
    expect(screen.queryByText('Procedure it runs')).toBeNull()
    await userEvent.type(screen.getByRole('textbox'), ' Carefully.')
    await userEvent.click(screen.getByRole('button', { name: 'Save as my own' }))

    await waitFor(() => expect(saveAgent).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'You do one thing. Carefully.', tools: ['read_file'], procedure: 'do-one-task' })))
  })

  it('holds an MCP server from the catalogue, still built in, and says holding a workspace one rebuilds its image', async () => {
    vi.mocked(saveAgent).mockImplementation(async (saved) => saved)
    await edit('executor')
    const server = await screen.findByRole('checkbox', { name: /playwright/ })
    expect(screen.getByText('in the workspace · 23 tools')).toBeInTheDocument()
    await userEvent.click(server)
    expect(screen.getByText(/installed in this agent's image, so holding one rebuilds it/)).toBeInTheDocument()
    expect(screen.getByText(/changing only its tools keeps it built in/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saveAgent).toHaveBeenCalledWith(expect.objectContaining({ slug: 'executor', servers: ['playwright'] })))
  })
})
