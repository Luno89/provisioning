import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as credentialsApi from '../../api/credentials'
import ModelsView from './ModelsView'

vi.mock('../../api/credentials', async (orig) => ({
  ...(await orig<typeof credentialsApi>()),
  listLlmProviders: vi.fn(),
  saveLlmCredentials: vi.fn(async () => ({})),
  deleteLlmCredentials: vi.fn(async () => undefined),
}))
vi.mock('./DefaultModelPicker', () => ({ DefaultModelPicker: () => <div data-testid="default-model" /> }))

const show = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ModelsView />
  </QueryClientProvider>,
)

const card = async (label: string) => (await screen.findAllByTestId('model-provider')).find((one) => one.textContent?.includes(label))!

describe('the Models page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(credentialsApi.listLlmProviders).mockResolvedValue([
      { provider: 'openrouter', label: 'OpenRouter', baseUrl: '', docsUrl: '', modelListAuth: false, icon: '◇', color: '#f60', modelCount: 418, hasKey: true },
    ])
  })

  it('shows the default model and every provider, with which are connected', async () => {
    show()
    expect(screen.getByTestId('default-model')).toBeInTheDocument()
    expect(await card('OpenRouter')).toHaveTextContent('418 models connected')
    expect(await card('Groq')).toHaveTextContent('Not connected')
  })

  it('connects a provider with its key', async () => {
    show()
    const groq = await card('Groq')
    fireEvent.click(within(groq).getByRole('button', { name: 'Connect' }))
    fireEvent.change(within(groq).getByPlaceholderText(/./), { target: { value: 'gsk-test' } })
    fireEvent.click(within(groq).getByRole('button', { name: /Connect and fetch models/ }))
    await waitFor(() => expect(credentialsApi.saveLlmCredentials).toHaveBeenCalledWith({ provider: 'groq', apiKey: 'gsk-test' }))
  })

  it('connects OpenRouter through the person\'s own OpenRouter account, with pasting a key still there', async () => {
    vi.mocked(credentialsApi.listLlmProviders).mockResolvedValue([])
    show()
    const openrouter = await card('OpenRouter')
    expect(within(openrouter).getByRole('link', { name: 'Connect OpenRouter' })).toHaveAttribute('href', credentialsApi.openRouterConnectUrl())
    expect(openrouter).toHaveTextContent(/nothing paid is picked for you/)
    fireEvent.click(within(openrouter).getByRole('button', { name: 'Paste a key' }))
    expect(within(openrouter).getByPlaceholderText(/sk-or/)).toBeInTheDocument()
    expect(within(await card('Groq')).queryByRole('link', { name: /Connect/ })).toBeNull()
  })

  it('says what happened on the way back from OpenRouter, and takes it off the address', async () => {
    window.history.replaceState(null, '', `/?openrouterError=${encodeURIComponent('OpenRouter did not give Koala a key.')}#/studio/models`)
    show()
    expect(await screen.findByRole('status')).toHaveTextContent('OpenRouter did not give Koala a key.')
    expect(window.location.search).toBe('')
    expect(window.location.hash).toBe('#/studio/models')
    window.history.replaceState(null, '', '/')
  })

  it('removes a provider only after asking', async () => {
    show()
    const openrouter = await card('OpenRouter')
    fireEvent.click(within(openrouter).getByRole('button', { name: 'Remove OpenRouter' }))
    expect(credentialsApi.deleteLlmCredentials).not.toHaveBeenCalled()
    fireEvent.click(within(openrouter).getByRole('button', { name: 'Remove it' }))
    await waitFor(() => expect(credentialsApi.deleteLlmCredentials).toHaveBeenCalledWith('openrouter'))
  })
})
