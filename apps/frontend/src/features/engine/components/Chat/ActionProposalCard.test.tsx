import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ActionProposal, ProposalProgress } from '@koala/harness-types'
import ActionProposalCard from './ActionProposalCard'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, params }: { children: React.ReactNode; to: string; params?: Record<string, string> }) =>
    <a href={Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to)}>{children}</a>,
}))

const progress = vi.hoisted(() => ({ now: undefined as ProposalProgress | undefined }))
vi.mock('../../api/actions', async () => {
  const actual = await vi.importActual<typeof import('../../api/actions')>('../../api/actions')
  return { ...actual, getActionProgress: vi.fn(async () => progress.now) }
})

const withQueries = (node: React.ReactNode) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>

const proposal = (over: Partial<ActionProposal> = {}): ActionProposal => ({
  id: 'a1', ownerId: 'u1', kind: 'deploy_project', summary: 'deploy billing from build b1',
  detail: ['Project: billing', 'Image: reg/billing:abc'], params: {}, status: 'proposed', createdAt: 'x', updatedAt: 'x', ...over,
})

describe('ActionProposalCard', () => {
  it('shows exactly what will happen, and applies or rejects', () => {
    const onApply = vi.fn()
    const onReject = vi.fn()
    render(<ActionProposalCard proposal={proposal()} busy={false} onApply={onApply} onReject={onReject} />)
    expect(screen.getByText('Image: reg/billing:abc')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onReject).toHaveBeenCalledTimes(1)
  })

  it('offers a retry with the reason when it failed, and nothing once applied', () => {
    const { rerender } = render(<ActionProposalCard proposal={proposal({ status: 'failed', reason: 'no memory' })} busy={false} onApply={() => {}} onReject={() => {}} />)
    expect(screen.getByText(/no memory/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    rerender(<ActionProposalCard proposal={proposal({ status: 'applied', result: 'deploying billing' })} busy={false} onApply={() => {}} onReject={() => {}} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('deploying billing')).toBeInTheDocument()
  })

  it('lays a proposal out in sections, with commands as code and the long part folded until opened', () => {
    render(<ActionProposalCard busy={false} onApply={() => {}} onReject={() => {}} proposal={proposal({
      kind: 'add_mcp_server', summary: 'add the MCP server playwright for executor', why: 'check pages in Odoo',
      sections: [
        { title: 'Who gets it', parts: [{ kind: 'text', text: 'executor — its workspace image is rebuilt with it' }] },
        { title: 'How it runs', folded: 'npm @playwright/mcp, port 8931', parts: [{ kind: 'fields', fields: [{ label: 'npm', value: '@playwright/mcp' }] }, { kind: 'code', label: 'start', code: 'playwright-mcp --port 8931' }] },
      ],
    })} />)
    expect(screen.getByText('check pages in Odoo')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Who gets it' })).toBeInTheDocument()
    expect(screen.queryByText('Project: billing')).toBeNull()
    const folded = screen.getByText('How it runs').closest('details')!
    expect(folded).not.toHaveAttribute('open')
    expect(within(folded).getByText('npm @playwright/mcp, port 8931')).toBeInTheDocument()
    expect(within(folded).getByText('playwright-mcp --port 8931').tagName).toBe('CODE')
  })

  it('once applied, follows what it started, then says it is ready with a way to the server', async () => {
    progress.now = { steps: [{ label: 'Added playwright', state: 'done' }, { label: 'Capturing its tools', state: 'running' }, { label: 'Building executor\'s image', state: 'running' }], done: false, server: { id: 's1', name: 'playwright' } }
    const applied = proposal({ kind: 'add_mcp_server', status: 'applied', result: 'added playwright', started: { server: { id: 's1', name: 'playwright', added: true }, images: ['executor'] }, sections: [{ title: 'Who gets it', parts: [{ kind: 'text', text: 'executor' }] }] })
    const { unmount } = render(withQueries(<ActionProposalCard proposal={applied} busy={false} onApply={() => {}} onReject={() => {}} />))
    expect(await screen.findByText('Capturing its tools')).toBeInTheDocument()
    expect(screen.getByText('Building executor\'s image')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Who gets it' })).toBeNull()
    unmount()

    progress.now = { ...progress.now, done: true, ready: 'playwright is ready for executor' }
    render(withQueries(<ActionProposalCard proposal={applied} busy={false} onApply={() => {}} onReject={() => {}} />))
    expect(await screen.findByText('playwright is ready for executor')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open playwright ›' })).toHaveAttribute('href', '/studio/mcp-servers/s1')
  })
})
