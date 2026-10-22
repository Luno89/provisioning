import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ExtensionsView from './ExtensionsView'
import type { ExtensionSummary } from '../../api/engine'
import { canvasContextFor } from '../../lib/procedure-drafts'

vi.mock('../../api/engine', async () => {
  const actual = await vi.importActual<typeof import('../../api/engine')>('../../api/engine')
  return { ...actual, listExtensions: vi.fn(), setExtensionEnabled: vi.fn(), createExtension: vi.fn(), updateExtension: vi.fn() }
})
vi.mock('../../api/agents', async () => {
  const actual = await vi.importActual<typeof import('../../api/agents')>('../../api/agents')
  return { ...actual, listAgents: vi.fn(async () => [{ slug: 'koala', name: 'Koala' }, { slug: 'my-helper', name: 'Helper', ownerId: 'u1' }]) }
})
vi.mock('../../api/engineTools', async () => {
  const actual = await vi.importActual<typeof import('../../api/engineTools')>('../../api/engineTools')
  return { ...actual, listEngineTools: vi.fn(async () => [{ name: 'my_tool', ownerId: 'u1' }]) }
})
vi.mock('../../api/procedures', async () => {
  const actual = await vi.importActual<typeof import('../../api/procedures')>('../../api/procedures')
  return { ...actual, listProcedures: vi.fn(async () => ({ procedures: [{ id: 'greeter', mine: true, ofBuiltIn: false }], unreadable: [] })) }
})

const { listExtensions, setExtensionEnabled, createExtension, updateExtension } = await import('../../api/engine')

const OPEN_TREE = {
  name: 'grove.open-tree', title: 'Open Tree', group: 'Grove', describe: 'Opens the tree.', inputs: [], outputs: [],
  exits: [{ name: 'ready', describe: 'open' }], settings: { type: 'object' as const, properties: {} }, summary: 'opens the tree', idempotent: true,
}

const extension = (over: Partial<ExtensionSummary>): ExtensionSummary => ({
  id: 'grove', title: 'Grove', describe: 'Trees of work.', version: '1', enabled: true, alwaysOn: false, authored: false, requires: ['platform'],
  operations: [OPEN_TREE], groups: [], tools: ['claim_leaf'], personas: ['grove'], procedures: ['grove-run'], ...over,
})

const PLATFORM = extension({ id: 'platform', title: 'Platform', alwaysOn: true, requires: [], operations: [], tools: ['list_tasks'], personas: ['koala'], procedures: [] })

const renderView = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ExtensionsView />
  </QueryClientProvider>,
)

beforeEach(() => {
  vi.mocked(listExtensions).mockReset()
  vi.mocked(setExtensionEnabled).mockReset()
})

describe('the extensions an owner has', () => {
  it('shows each with what it brings, the platform always on, and switches one off', async () => {
    vi.mocked(listExtensions).mockResolvedValueOnce([PLATFORM, extension({})]).mockResolvedValue([PLATFORM, extension({ enabled: false })])
    vi.mocked(setExtensionEnabled).mockResolvedValue([PLATFORM, extension({ enabled: false })])
    renderView()

    const platform = await screen.findByLabelText('Platform is on')
    expect(platform).toBeChecked()
    expect(platform).toBeDisabled()
    expect(screen.getByText(/1 node · 1 agent · 1 tool · 1 procedure/)).toBeInTheDocument()

    await userEvent.click(screen.getByLabelText('Grove is on'))
    expect(setExtensionEnabled).toHaveBeenCalledWith('grove', false)
    await waitFor(() => expect(screen.getByLabelText('Grove is on')).not.toBeChecked())
  })

  it('says why a switch was refused', async () => {
    vi.mocked(listExtensions).mockResolvedValue([PLATFORM, extension({})])
    vi.mocked(setExtensionEnabled).mockRejectedValue(Object.assign(new Error('Request failed'), { isAxiosError: true, response: { data: { error: 'Notes needs Grove, so switch that off first' } } }))
    renderView()

    await userEvent.click(await screen.findByLabelText('Grove is on'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Notes needs Grove/)
  })

  it('makes an extension of the owner\'s own', async () => {
    vi.mocked(listExtensions).mockResolvedValue([PLATFORM])
    vi.mocked(createExtension).mockResolvedValue([PLATFORM])
    renderView()

    await userEvent.type(await screen.findByLabelText("New extension's id"), 'loud')
    await userEvent.type(screen.getByLabelText("New extension's title"), 'Loud')
    await userEvent.click(screen.getByRole('button', { name: /New extension/ }))

    expect(createExtension).toHaveBeenCalledWith({ id: 'loud', title: 'Loud', describe: '' })
  })

  it('lists the latest version of each operation, and bundles only the owner\'s own agents, tools and procedures', async () => {
    const shout = { id: 'loud.shout@2', title: 'Shout', describe: '', inputs: [], outputs: [], exits: [], start: 'x', nodes: [], wires: [], flow: [] }
    const loud = extension({ id: 'loud', title: 'Loud', authored: true, requires: [], operations: [], groups: [{ ...shout, id: 'loud.shout@1' }, shout], latest: ['loud.shout@2'], tools: [], personas: [], procedures: [] })
    vi.mocked(listExtensions).mockResolvedValue([PLATFORM, loud])
    vi.mocked(updateExtension).mockResolvedValue([PLATFORM, loud])
    renderView()

    expect(await screen.findByText('loud.shout@2')).toBeInTheDocument()
    expect(screen.queryByText('loud.shout@1')).not.toBeInTheDocument()
    expect(screen.getByText(/2 versions/)).toBeInTheDocument()
    expect(await screen.findByLabelText('Bundle my-helper')).toBeInTheDocument()
    expect(screen.queryByLabelText('Bundle koala')).not.toBeInTheDocument()

    await userEvent.click(screen.getByLabelText('Bundle greeter'))
    expect(updateExtension).toHaveBeenCalledWith('loud', { procedures: ['greeter'] })
  })
})

describe('the Studio\'s node language', () => {
  it('still draws a switched-off extension\'s nodes, but no longer offers them in the palette', () => {
    const context = canvasContextFor([extension({ enabled: false })])
    expect(context.catalogue.get('host-op')).toBeDefined()
    expect(context.operations).toEqual([])
    expect(canvasContextFor([extension({})]).operations?.map((operation) => operation.name)).toEqual(['grove.open-tree'])
  })

  it('keeps every published version drawable, but offers only the latest, and none from a switched-off extension', () => {
    const shout = (id: string) => ({ id, title: 'Shout', describe: '', inputs: [], outputs: [], exits: [], start: 'x', nodes: [], wires: [], flow: [] })
    const loud = extension({ id: 'loud', authored: true, operations: [], groups: [shout('loud.shout@1'), shout('loud.shout@2')], latest: ['loud.shout@2'] })

    const on = canvasContextFor([loud])
    expect(on.shared?.map((group) => group.id)).toEqual(expect.arrayContaining(['loud.shout@1', 'loud.shout@2']))
    expect([...on.retired ?? []]).toEqual(['loud.shout@1'])
    expect([...canvasContextFor([{ ...loud, enabled: false }]).retired ?? []]).toEqual(['loud.shout@1', 'loud.shout@2'])
  })
})
