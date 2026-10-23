import { render, screen, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as infrastructureApi from '../api/infrastructure'
import type { InfrastructureOverview, KoalaView } from '../api/infrastructure'
import { KoalaSection } from './KoalaSection'
import { koalaFigures } from '../lib/koala-figures'

vi.mock('../api/infrastructure', async (orig) => ({ ...(await orig<typeof infrastructureApi>()), getInfrastructure: vi.fn() }))

const koala: KoalaView = {
  state: 'ok',
  reasons: [],
  numbers: { requestsPerSecond: 2.5, requestErrorShare: 0.01, requestSeconds: 0.25, modelCallsPerMinute: 3, modelErrorShare: 0, modelSeconds: 12, modelQueued: 2, workflowsStartedHour: 5, activityFailuresHour: 0, workFailuresDay: 1 },
  services: ['koala-backend', 'koala-worker-engine'],
  lines: ['Koala is healthy.', '2 processes report: koala-backend, koala-worker-engine.'],
  telemetry: { collector: true, tempo: true },
  checkedAt: new Date().toISOString(),
}

const overview = (over: Partial<KoalaView>): InfrastructureOverview => ({
  monitoring: { attention: [], apps: [], clusters: [], firing: [], checkedAt: koala.checkedAt },
  koala: { ...koala, ...over },
  workloads: [], waiting: [], running: 0, failures: [],
})

const show = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><KoalaSection /></QueryClientProvider>)

describe('the Koala section', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('shows what Koala reports about itself: its state, who reports, and each number in plain units', async () => {
    vi.mocked(infrastructureApi.getInfrastructure).mockResolvedValue(overview({}))
    show()
    expect(await screen.findByTestId('koala-state')).toHaveTextContent('Koala is healthy.')
    expect(screen.getByRole('heading', { name: 'Koala' })).toBeInTheDocument()
    expect(screen.getByTestId('koala-services')).toHaveTextContent('2 processes report: koala-backend, koala-worker-engine.')
    const numbers = screen.getByLabelText("Koala's own numbers")
    expect(within(numbers).getByText('Requests').nextSibling).toHaveTextContent('2.5/s')
    expect(within(numbers).getByText('Requests failing').nextSibling).toHaveTextContent('1%')
    expect(within(numbers).getByText('Request time (p95)').nextSibling).toHaveTextContent('250 ms')
    expect(within(numbers).getByText('Model calls').nextSibling).toHaveTextContent('3.0/min')
    expect(within(numbers).getByText('Model time (p95)').nextSibling).toHaveTextContent('12 s')
    expect(within(numbers).getByText('Waiting for a model').nextSibling).toHaveTextContent('2')
    expect(within(numbers).getByText('Work failed, last day').nextSibling).toHaveTextContent('1')
  })

  it('says what is not measured as not measured, never as fine', () => {
    const figures = koalaFigures({ requestsPerSecond: 0.02 })
    expect(figures.find((figure) => figure.label === 'Requests')?.value).toBe('under 0.1/s')
    expect(figures.filter((figure) => figure.value === 'not measured')).toHaveLength(9)
  })

  it('says while the collector or Tempo is missing that they come with the cluster worker or the next deploy', async () => {
    vi.mocked(infrastructureApi.getInfrastructure).mockResolvedValue(overview({ state: 'installing', reasons: ['its collector and Tempo are installed when the cluster worker starts or an app is deployed'], numbers: {}, services: [], lines: ['Koala is getting its monitoring: its collector and Tempo are installed when the cluster worker starts or an app is deployed.'], telemetry: { collector: false, tempo: true } }))
    show()
    expect(await screen.findByText(/Its collector is not on the system cluster yet/)).toBeInTheDocument()
    expect(screen.queryByLabelText("Koala's own numbers")).toBeNull()
    expect(screen.getByTestId('koala-state')).toHaveTextContent('Koala is getting its monitoring')
  })

  it('shows Koala down when nothing of it reports', async () => {
    vi.mocked(infrastructureApi.getInfrastructure).mockResolvedValue(overview({ state: 'down', reasons: ['no part of Koala is reporting'], services: [], numbers: {}, lines: ['Koala is down: no part of Koala is reporting.'] }))
    show()
    expect(await screen.findByText('Nothing of Koala reports to its collector.')).toBeInTheDocument()
    expect(screen.getByTestId('koala-state')).toHaveTextContent('down')
  })
})
