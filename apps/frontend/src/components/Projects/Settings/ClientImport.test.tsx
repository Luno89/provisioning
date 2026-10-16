import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClientImport } from './ClientImport'
import * as api from '../../../api/client-import'
import type { ImportView } from '../../../api/client-import'

vi.mock('../../../api/client-import', async (orig) => ({
  ...(await orig<typeof api>()),
  startFresh: vi.fn(async () => ({ released: true })),
  uploadImport: vi.fn(async (_p: string, _f: File, mode: api.ImportMode, progress: (n: number) => void) => { progress(1); return { state: 'uploaded', mode, bytes: 2, at: 'now' } }),
}))

const show = (view: ImportView) => render(
  <QueryClientProvider client={new QueryClient()}>
    <ClientImport projectId="p1" view={view} />
  </QueryClientProvider>,
)

describe('starting a project from a client\'s database', () => {
  beforeEach(() => vi.clearAllMocks())

  it('uploads the chosen backup as a copy unless the person says it is their live system', async () => {
    show({ open: true })
    const button = screen.getByRole('button', { name: /Start from this backup/ })
    expect(button).toBeDisabled()
    const file = new File(['PK'], 'client.zip', { type: 'application/zip' })
    fireEvent.change(screen.getByLabelText('The client\'s backup'), { target: { files: [file] } })
    fireEvent.click(screen.getByLabelText(/The client's live system/))
    fireEvent.click(button)
    await waitFor(() => expect(api.uploadImport).toHaveBeenCalledWith('p1', file, 'live', expect.any(Function)))
  })

  it('says why it was refused, naming the missing modules', () => {
    show({ open: true, import: { state: 'refused', mode: 'copy', bytes: 2, version: '20.0', missing: ['web_studio'], reason: 'the client\'s database has a module installed that this project does not: web_studio', at: 'x' } })
    expect(screen.getByText(/Refused: the client's database has a module/)).toBeInTheDocument()
    expect(screen.getByText('web_studio')).toBeInTheDocument()
  })

  it('says how it started once imported, and offers nothing more', () => {
    show({ open: false, why: 'Shop has already released', import: { state: 'imported', mode: 'copy', bytes: 2, version: '20.0', modules: ['base', 'sale'], at: 'x' } })
    expect(screen.getByText(/Started from the client's database \(Odoo 20.0, 2 modules, as a copy to work on\)/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('waits for the client\'s backup, and can start without it', async () => {
    show({ open: true, import: { state: 'awaited', mode: 'copy', bytes: 0, at: 'x' } })
    expect(screen.getByText(/its first release waits for their backup/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start without their database' }))
    await waitFor(() => expect(api.startFresh).toHaveBeenCalledWith('p1'))
  })
})
