import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import AgentsView from './AgentsView'
import { blankAgent, toolProblem } from './agent-forms'
import type { Agent, GrantableTool } from '../../api/agents'

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

const { listAgents, listGrantableTools, saveAgent, deleteAgent } = await import('../../api/agents')

const TOOLS: GrantableTool[] = [
  { name: 'read_file', summary: 'Read a file', binding: 'environment', needs: ['filesystem'] },
  { name: 'search_web', summary: 'Search the web', binding: 'network', needs: [] },
  { name: 'mark_done', summary: 'Finish a task', binding: 'platform', needs: [] },
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
  environment: { terminal: true, filesystem: true },
  mine: false,
  image: { state: 'ready', reference: 'registry/koala:abc' },
  ...over,
})

const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><AgentsView /></QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  const koala = agent({ slug: 'koala', name: 'Koala', tools: [], environment: {}, mine: true })
  delete koala.image
  vi.mocked(listAgents).mockResolvedValue([agent(), koala])
  vi.mocked(listGrantableTools).mockResolvedValue({ tools: TOOLS, languages: ['node', 'python', 'go'] })
})

describe('the agents a person can edit', () => {
  it('lists each agent with whose it is, what it runs and what its workspace is doing', async () => {
    show()

    expect(await screen.findByText('executor')).toBeInTheDocument()
    expect(screen.getByText('built-in')).toBeInTheDocument()
    expect(screen.getByText('yours')).toBeInTheDocument()
    expect(screen.getByText('workspace ready')).toBeInTheDocument()
    expect(screen.getAllByText('do-one-task')).toHaveLength(2)
  })

  it('opens one and offers to save your own copy of a built-in', async () => {
    show()

    await userEvent.click(await screen.findByText('executor'))

    expect(screen.getByText(/Your own copy of Executor/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save as my own' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete my copy' })).not.toBeInTheDocument()
  })

  it('saves the tools it was granted', async () => {
    vi.mocked(saveAgent).mockResolvedValue(agent({ mine: true, tools: ['read_file', 'search_web'] }))
    show()

    await userEvent.click(await screen.findByText('executor'))
    await userEvent.click(screen.getByRole('checkbox', { name: /search_web/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Save as my own' }))

    await waitFor(() => expect(saveAgent).toHaveBeenCalledWith(expect.objectContaining({
      slug: 'executor',
      tools: ['read_file', 'search_web'],
    })))
  })

  it('only offers to delete an agent of your own', async () => {
    show()

    await userEvent.click(await screen.findByText('koala'))
    await userEvent.click(screen.getByRole('button', { name: 'Delete my copy' }))

    await waitFor(() => expect(deleteAgent).toHaveBeenCalledWith('koala'))
  })

  it('starts a new agent from a name', async () => {
    show()

    await userEvent.type(await screen.findByLabelText('Name of the new agent'), 'Digger Deluxe')
    await userEvent.click(screen.getByRole('button', { name: /New agent/ }))

    expect(screen.getByText(/Editing Digger Deluxe/)).toBeInTheDocument()
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
    show()

    await userEvent.click(await screen.findByText('executor'))

    expect(screen.getByText(/A workspace can ask for node, python, go/)).toBeInTheDocument()
  })
})

describe('the grants a procedure requires', () => {
  it('says what they are and why, and will not let you turn one off', async () => {
    vi.mocked(listAgents).mockResolvedValue([agent({ procedure: 'do-one-task', tools: ['read_file', 'mark_done'], agents: ['judge'], mine: true })])
    show()

    await userEvent.click(await screen.findByText('executor'))

    expect(screen.getByText('What do-one-task needs')).toBeInTheDocument()
    expect(screen.getByText('The outcome is recorded for you.', { exact: false })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /mark_done/ })).toBeDisabled()
  })

  it('ticks what the procedure needs when you switch to it', async () => {
    vi.mocked(saveAgent).mockResolvedValue(agent({ mine: true }))
    show()

    await userEvent.click(await screen.findByText('executor'))
    await userEvent.selectOptions(screen.getByLabelText('Procedure it runs'), 'do-one-task')
    await userEvent.click(screen.getByRole('button', { name: /Save/ }))

    await waitFor(() => expect(saveAgent).toHaveBeenCalledWith(expect.objectContaining({
      procedure: 'do-one-task',
      tools: expect.arrayContaining(['mark_done']),
      agents: expect.arrayContaining(['judge']),
    })))
  })
})
