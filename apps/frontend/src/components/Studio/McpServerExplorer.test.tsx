import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import McpServerExplorer from './McpServerExplorer'

const params = vi.hoisted(() => ({ id: undefined as string | undefined, part: undefined as string | undefined }))
const calls = vi.hoisted(() => ({ add: [] as unknown[], save: [] as unknown[], capture: [] as unknown[], agent: [] as unknown[] }))

vi.mock('@tanstack/react-router', () => ({
  useParams: () => params,
  useNavigate: () => vi.fn(),
  Link: ({ children, to, params: linked }: { children: React.ReactNode; to: string; params?: Record<string, string> }) =>
    <a href={Object.entries(linked ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to)}>{children}</a>,
}))

const RUNS = { where: 'workspace' as const, install: [{ via: 'npm' as const, packages: ['@playwright/mcp'] }], start: 'playwright-mcp', port: 8931 }
const SERVERS = [
  {
    id: 'p1', name: 'playwright', runs: RUNS, omit: ['browser_take_screenshot'], status: { state: 'captured', tools: 2 }, createdAt: 't', updatedAt: 't',
    captured: { instructions: 'Snapshot first.', tools: [
      { name: 'browser_snapshot', description: 'Read the page.', annotations: { readOnlyHint: true } },
      { name: 'browser_click', description: 'Click.', inputSchema: { type: 'object', properties: { ref: { type: 'string' } } } },
      { name: 'browser_take_screenshot', description: 'Picture.' },
    ], at: '2026-10-12T10:00:00Z' },
  },
  { id: 'd1', name: 'docs', runs: { where: 'hosted' as const, url: 'http://docs.test/mcp' }, status: { state: 'failed', why: 'connection refused' }, createdAt: 't', updatedAt: 't' },
]

vi.mock('../../api/workspaceDependencies', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/workspaceDependencies')>()),
  useDependencies: () => ({ isPending: false, isError: false, error: null, data: [{ name: 'jq', summary: 'jq.', provides: ['jq'], install: [], mine: false, script: false, usedBy: { tools: [], servers: [], dependencies: [], steps: [], trees: [] } }] }),
}))

vi.mock('../Checks/shared', async (importOriginal) => ({ ...(await importOriginal<typeof import('../Checks/shared')>()), useScenarios: () => ({ data: [] }), useLevel2Runs: () => ({ data: [] }) }))

vi.mock('./shared', () => {
  const mutation = (into: unknown[]) => ({ mutate: (value: unknown) => { into.push(value) }, isPending: false, error: null })
  return {
    errorMessage: (err: unknown) => String(err),
    useMcpCatalogue: () => ({ isPending: false, isError: false, data: { servers: SERVERS, templates: [{ id: 'playwright', name: 'playwright', summary: 'A headless browser.', runs: RUNS, added: true }] } }),
    useAddMcpServer: () => mutation(calls.add),
    useSaveMcpServer: () => mutation(calls.save),
    useCaptureMcpServer: () => mutation(calls.capture),
    useRemoveMcpServer: () => mutation([]),
    useSaveAgent: () => mutation(calls.agent),
    useAgents: () => ({ data: [{ slug: 'executor', tools: [], servers: ['playwright'] }, { slug: 'koala', tools: [], servers: [] }] }),
    useEngineTools: () => ({ isPending: false, isError: false, error: null, data: [] }),
  }
})

beforeEach(() => {
  params.id = undefined
  params.part = undefined
  calls.add = []
  calls.save = []
  calls.capture = []
  calls.agent = []
})

describe('the MCP servers explorer', () => {
  it('groups servers by where they run, and adds a known one or one at an address', async () => {
    render(<McpServerExplorer />)
    const tree = within(screen.getByRole('complementary', { name: 'Tools' }))
    expect(tree.getByRole('button', { name: /^MCP Servers/ })).toBeInTheDocument()
    expect(tree.getByText('Run in the workspace')).toBeInTheDocument()
    expect(tree.getByText('Hosted at an address')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Add another' }))
    expect(calls.add).toEqual([{ template: 'playwright' }])

    await userEvent.type(screen.getByRole('textbox', { name: 'Server name' }), 'wiki')
    await userEvent.type(screen.getByRole('textbox', { name: 'Server address' }), 'http://wiki.test/mcp')
    await userEvent.click(screen.getByRole('button', { name: 'Add and capture' }))
    expect(calls.add[1]).toEqual({ name: 'wiki', runs: { where: 'hosted', url: 'http://wiki.test/mcp' } })
  })

  it('opens a server on what it says about itself and who holds it, and gives it to an agent', async () => {
    params.id = 'p1'
    render(<McpServerExplorer />)
    expect(screen.getByText(/Snapshot first\./)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'executor' })).toBeChecked()
    await userEvent.click(screen.getByRole('checkbox', { name: 'koala' }))
    expect(calls.agent).toEqual([expect.objectContaining({ slug: 'koala', servers: ['playwright'] })])
    await userEvent.click(screen.getByRole('button', { name: /Capture again/ }))
    expect(calls.capture).toEqual(['p1'])
  })

  it('says why a capture failed', () => {
    params.id = 'd1'
    render(<McpServerExplorer />)
    expect(screen.getByRole('alert')).toHaveTextContent('connection refused')
  })

  it('lets the person choose which tools to offer and say what each really does', async () => {
    params.id = 'p1'
    params.part = 'tools'
    render(<McpServerExplorer />)
    expect(screen.getByRole('checkbox', { name: 'Offer browser_take_screenshot' })).not.toBeChecked()
    expect(screen.getByText('takes ref')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Offer browser_click' }))
    expect(calls.save).toEqual([{ offer: null, omit: ['browser_take_screenshot', 'browser_click'] }])

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'What browser_click does' }), 'safe-write')
    expect(calls.save[1]).toEqual({ tools: { browser_click: { kind: 'safe-write' } } })
  })
})
