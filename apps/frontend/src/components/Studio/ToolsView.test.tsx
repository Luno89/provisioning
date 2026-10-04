import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ToolsView from './ToolsView'
import { blanksIn, blankTool, commandProblems, packagesOf } from './tool-forms'
import type { EngineTool } from '../../api/engineTools'

vi.mock('../../api/engineTools', async () => {
  const actual = await vi.importActual<typeof import('../../api/engineTools')>('../../api/engineTools')
  return {
    ...actual,
    listEngineTools: vi.fn(),
    saveEngineTool: vi.fn(),
    deleteEngineTool: vi.fn(async () => undefined),
  }
})

const { listEngineTools, saveEngineTool, deleteEngineTool } = await import('../../api/engineTools')

const tool = (over: Partial<EngineTool> = {}): EngineTool => ({
  name: 'count_lines',
  summary: 'Counts the lines that match',
  binding: 'environment',
  effect: 'read',
  idempotent: false,
  openWorld: false,
  parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'what to look for' } } },
  returns: 'the number of matching lines',
  failures: [{ when: 'the path does not exist', says: 'no such file' }],
  command: 'rg --count {pattern}',
  needsBinaries: ['rg'],
  install: { via: 'dnf', packages: ['ripgrep'] },
  mine: false,
  grantedTo: ['executor'],
  ...over,
})

const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><ToolsView /></QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listEngineTools).mockResolvedValue([tool(), tool({ name: 'jq_query', mine: true, grantedTo: [] })])
})

describe('the tools a person can edit', () => {
  it('lists each with its command, the binary it needs and who was granted it', async () => {
    show()

    expect(await screen.findByText('count_lines')).toBeInTheDocument()
    expect(screen.getAllByText('rg --count {pattern}')).toHaveLength(2)
    expect(screen.getAllByText('needs rg')).toHaveLength(2)
    expect(screen.getByText('granted to executor')).toBeInTheDocument()
    expect(screen.getByText('granted to nobody')).toBeInTheDocument()
  })

  it('offers to save your own copy of a built-in', async () => {
    show()

    await userEvent.click(await screen.findByText('count_lines'))

    expect(screen.getByText(/Your own copy of count_lines/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete my copy' })).not.toBeInTheDocument()
  })

  it('saves the command and the install recipe', async () => {
    vi.mocked(saveEngineTool).mockResolvedValue({ tool: tool({ mine: true }), rebuilding: [], failed: [] })
    show()

    await userEvent.click(await screen.findByText('jq_query'))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(saveEngineTool).toHaveBeenCalledWith(expect.objectContaining({
      command: 'rg --count {pattern}',
      needsBinaries: ['rg'],
      install: { via: 'dnf', packages: ['ripgrep'] },
    })))
  })

  it('saves a tool stored before the two flags were required, saying false rather than nothing', async () => {
    const stored = { ...tool({ name: 'json_query', mine: true, grantedTo: ['executor'] }) } as Partial<EngineTool>
    delete stored.idempotent
    delete stored.openWorld
    vi.mocked(listEngineTools).mockResolvedValue([stored as EngineTool])
    vi.mocked(saveEngineTool).mockResolvedValue({ tool: stored as EngineTool, rebuilding: ['executor'], failed: [] })
    show()

    await userEvent.click(await screen.findByText('json_query'))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(saveEngineTool).toHaveBeenCalledWith(expect.objectContaining({
      idempotent: false,
      openWorld: false,
    })))
  })

  it('asks whether a tool that writes can destroy something, and saves the answer', async () => {
    vi.mocked(listEngineTools).mockResolvedValue([tool({ name: 'wipe_cache', effect: 'write', mine: true })])
    vi.mocked(saveEngineTool).mockResolvedValue({ tool: tool({ mine: true }), rebuilding: [], failed: [] })
    show()

    await userEvent.click(await screen.findByText('wipe_cache'))
    const question = screen.getByRole('combobox', { name: 'Can it destroy or overwrite something' })
    expect(question).toHaveValue('')
    await userEvent.selectOptions(question, 'yes')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(saveEngineTool).toHaveBeenCalledWith(expect.objectContaining({ effect: 'write', destructive: true })))
  })

  it('does not ask a tool that only reads, and drops the answer when a tool stops writing', async () => {
    vi.mocked(listEngineTools).mockResolvedValue([tool({ name: 'wipe_cache', effect: 'write', destructive: true, mine: true })])
    vi.mocked(saveEngineTool).mockResolvedValue({ tool: tool({ mine: true }), rebuilding: [], failed: [] })
    show()

    await userEvent.click(await screen.findByText('wipe_cache'))
    await userEvent.selectOptions(screen.getByDisplayValue(/write — changes things/), 'read')
    expect(screen.queryByRole('combobox', { name: 'Can it destroy or overwrite something' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(saveEngineTool).toHaveBeenCalled())
    expect(vi.mocked(saveEngineTool).mock.calls[0]![0]).not.toHaveProperty('destructive')
  })

  it('says which agents are rebuilding a workspace to get it', async () => {
    vi.mocked(saveEngineTool).mockResolvedValue({ tool: tool({ mine: true }), rebuilding: ['executor', 'judge'], failed: [] })
    show()

    await userEvent.click(await screen.findByText('jq_query'))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(/executor, judge are rebuilding a workspace/)).toBeInTheDocument()
  })

  it('says when a workspace could not start building, and keeps the editor open on it', async () => {
    vi.mocked(saveEngineTool).mockResolvedValue({
      tool: tool({ mine: true }),
      rebuilding: [],
      failed: [{ agent: 'executor', detail: 'Could not find the image registry (gitea-http in gitea)' }],
    })
    show()

    await userEvent.click(await screen.findByText('jq_query'))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(/executor's workspace could not start building/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('asks for an install script only when the recipe is a script', async () => {
    show()

    await userEvent.click(await screen.findByText('jq_query'))
    expect(screen.queryByLabelText(/Install script/i)).not.toBeInTheDocument()

    await userEvent.selectOptions(screen.getByLabelText('How they get installed'), 'script')

    expect(screen.getByText(/runs as root while the image is built/)).toBeInTheDocument()
  })

  it('will not save a command that fills in an argument the tool does not take', async () => {
    show()

    await userEvent.click(await screen.findByText('jq_query'))
    await userEvent.clear(screen.getByLabelText('Command it runs in the workspace'))
    await userEvent.type(screen.getByLabelText('Command it runs in the workspace'), 'rg {{nowhere}')

    expect(screen.getByText('the command fills in {nowhere}, which is not an argument')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(saveEngineTool).not.toHaveBeenCalled()
  })

  it('only offers to delete a tool of your own', async () => {
    show()

    await userEvent.click(await screen.findByText('jq_query'))
    await userEvent.click(screen.getByRole('button', { name: 'Delete my copy' }))

    await waitFor(() => expect(deleteEngineTool).toHaveBeenCalledWith('jq_query'))
  })

  it('starts a new tool from a name, in the shape a tool has to have', async () => {
    show()

    await userEvent.type(await screen.findByLabelText('Name of the new tool'), 'Count Words')
    await userEvent.click(screen.getByRole('button', { name: /New tool/ }))

    expect(screen.getByText(/Editing count_words/)).toBeInTheDocument()
  })
})

describe('what a blank tool starts as', () => {
  it('runs in the workspace, takes nothing and installs nothing yet', () => {
    expect(blankTool('count_words')).toMatchObject({
      name: 'count_words',
      binding: 'environment',
      parameters: { type: 'object', properties: {} },
      install: { via: 'base' },
      mine: true,
    })
  })
})

describe('the blanks in a command', () => {
  it('names each one once', () => {
    expect(blanksIn('rg {pattern} {path} {pattern}')).toEqual(['pattern', 'path'])
  })

  it('complains only about blanks that are not arguments', () => {
    expect(commandProblems('rg {pattern} {path}', ['pattern'])).toEqual([
      'the command fills in {path}, which is not an argument',
    ])
  })

  it('reads the packages back out of an install that has them', () => {
    expect(packagesOf({ via: 'dnf', packages: ['ripgrep', 'jq'] })).toBe('ripgrep, jq')
    expect(packagesOf({ via: 'base' })).toBe('')
  })
})
