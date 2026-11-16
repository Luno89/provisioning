import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { toolCallParsersOn } from '../../../test/backend/tool-calling'
import { startBackend } from '../../../test/backend/site'
import { toolCallParsersRouter } from '../../../../../backend/src/models/routes/tool-call-parsers'
import { deploymentsRouter } from '../../../../../backend/src/infrastructure/routes/deployments'
import AppDeployWizard from './AppDeployWizard'
import type { Cluster } from '../types/cluster'

const backend = await startBackend(async (site) => {
  const { parsers } = await toolCallParsersOn(site, { 'Qwen/Qwen3.6-27B': { fixture: 'Qwen/Qwen3.6-27B' } })
  site.api.use('/tool-call-parsers', toolCallParsersRouter({ parsers }))
  const unreached = {} as never
  site.api.use('/deployments', deploymentsRouter({ db: site.db, appService: unreached, clusterService: unreached, appExposureService: unreached, temporalBridge: unreached, toolCalling: parsers, io: unreached }))
})
await backend.signIn()

const rig: Cluster[] = [{ id: 'rig', name: 'rig', provider: 'machine', status: 'healthy', gpus: [{ vendor: 'nvidia', model: 'RTX 3090', memoryMiB: 24576, count: 1, runtime: true }] }]

describe('the deploy wizard\'s tool calling, against the real catalogue and tool call parser routes', () => {
  it('chooses the parser from the chat template of the model typed, and offers every parser Koala knows to pick another', async () => {
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AppDeployWizard clusters={rig} deployments={[]} onClose={() => undefined} onDeploy={() => undefined} /></QueryClientProvider>)
    const user = userEvent.setup()
    const appType = await screen.findByLabelText(/application type/i)
    await within(appType).findByRole('option', { name: /vllm/i })
    await user.selectOptions(appType, 'vllm')
    await user.selectOptions(screen.getByLabelText(/target cluster/i), 'rig')
    for (let step = 0; step < 3; step++) await user.click(screen.getByRole('button', { name: /^Next/ }))
    await user.type(screen.getByLabelText(/^HuggingFace Model ID/), 'Qwen/Qwen3.6-27B')
    const parser = screen.getByLabelText(/^Tool Call Parser/)
    expect(await within(parser).findByRole('option', { name: 'Chosen from its chat template: qwen3_coder' })).toBeTruthy()
    expect(within(parser).getByRole('option', { name: 'qwen3_coder — Qwen 3.5, 3.6' })).toBeTruthy()
    expect(within(parser).getAllByRole('option')).toHaveLength(55)
  })
})
