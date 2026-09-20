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
  parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'what to look for' } } },
  returns: 'the number of matching lines',
  failures: [{ when: 'the path does not exist', says: 'no such file' }],
  command: 'rg --count {pattern}',
  needsBinaries: ['rg'],
  install: { via: 'dnf', packages: ['ripgrep'] },
  status: 'draft',
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
    vi.mocked(saveEngineTool).mockResolvedValue({ tool: tool({ mine: true }), rebuilding: [] })
    show()

    await userEvent.click(await screen.findByText('jq_query'))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(saveEngineTool).toHaveBeenCalledWith(expect.objectContaining({
      command: 'rg --count {pattern}',
      needsBinaries: ['rg'],
      install: { via: 'dnf', packages: ['ripgrep'] },
    })))
  })

  it('says which agents are rebuilding a workspace to get it', async () => {
    vi.mocked(saveEngineTool).mockResolvedValue({ tool: tool({ mine: true }), rebuilding: ['executor', 'judge'] })
    show()

    await userEvent.click(await screen.findByText('jq_query'))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(/executor, judge are rebuilding a workspace/)).toBeInTheDocument()
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
