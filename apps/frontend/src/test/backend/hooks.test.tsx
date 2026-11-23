import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { shown } from './hooks'

function Reading() {
  const read = useQuery({ queryKey: ['reading'], queryFn: async (): Promise<string> => { throw new Error('the server said no') } })
  if (read.isError) return <p role="alert">{read.error.message}</p>
  return <p>reading</p>
}

const opened = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const page = render(<QueryClientProvider client={client}><Reading /></QueryClientProvider>)
  return { client, page }
}

function servedPage(first: string) {
  let value = first
  function Served() {
    const read = useQuery({ queryKey: ['served'], queryFn: async (): Promise<string> => value })
    return <p>{read.data ?? 'reading'}</p>
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const page = render(<QueryClientProvider client={client}><Served /></QueryClientProvider>)
  return { client, page, serve: (next: string) => { value = next } }
}

describe('a test\'s wait for what a page shows', () => {
  it('finds the failure the page shows when that failure is what it waits for', async () => {
    const { client, page } = opened()
    expect((await shown(() => screen.queryByRole('alert'), { client, followsSocket: false })).textContent).toBe('the server said no')
    page.unmount()
  })

  it('keeps waiting for a failure the page shows once its other query, which failed first, is shown failing', async () => {
    let refuse: (err: Error) => void = () => undefined
    const later = new Promise<string>((_resolve, reject) => { refuse = reject })
    function Later() {
      const read = useQuery({ queryKey: ['later'], queryFn: () => later })
      return read.isError ? <p role="status">{read.error.message}</p> : <p>still reading</p>
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const page = render(<QueryClientProvider client={client}><Reading /><Later /></QueryClientProvider>)
    const waited = shown(() => screen.queryByRole('status'), { client, followsSocket: false })
    await shown(() => screen.queryByRole('alert'), { client, followsSocket: false })
    refuse(new Error('the later server said no'))
    expect((await waited).textContent).toBe('the later server said no')
    page.unmount()
  })

  it('ends with why once the page\'s query failed and the page shows something else', async () => {
    const { client, page } = opened()
    await expect(shown(() => screen.queryByText('the answer'), { client, followsSocket: false })).rejects.toThrow('what this waits for can never be shown: the page\'s ["reading"] failed: the server said no')
    page.unmount()
  })

  it('finds what a change brings once the page takes it in, however late it hears of it', async () => {
    const { client, page, serve } = servedPage('before')
    await shown(() => screen.queryByText('before'), { client, followsSocket: false })
    const waited = shown(() => screen.queryByText('after'), { client, followsSocket: false }, async () => { serve('after') })
    await client.invalidateQueries({ queryKey: ['served'] })
    expect((await waited).textContent).toBe('after')
    page.unmount()
  })

  it('ends with why once the change is made and the page holds what the backend holds without showing it', async () => {
    const { client, page, serve } = servedPage('before')
    await shown(() => screen.queryByText('before'), { client, followsSocket: false })
    const change = async () => { serve('after'); await client.invalidateQueries({ queryKey: ['served'] }) }
    await expect(shown(() => screen.queryByText('something else'), { client, followsSocket: false }, change)).rejects.toThrow('what this waits for can never be shown: the change is made, the page holds what the backend holds and does not show it; the page shows "after"')
    page.unmount()
  })
})
