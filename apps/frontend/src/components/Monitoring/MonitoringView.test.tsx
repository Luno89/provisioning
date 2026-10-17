import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as monitoringApi from '../../api/monitoring'
import type { AppHealthView, ClusterRow, Overview } from '../../api/monitoring'

const params: { kind?: string; id?: string } = {}
vi.mock('@tanstack/react-router', () => ({ useParams: () => params }))
vi.mock('./Chart', () => ({ Chart: ({ title }: { title: string }) => <figure aria-label={title} /> }))
vi.mock('../../api/monitoring', async (orig) => ({
  ...(await orig<typeof monitoringApi>()),
  getOverview: vi.fn(),
  getAlerts: vi.fn(),
  getAppHealth: vi.fn(),
  getClusterHealth: vi.fn(),
  setHistoryDays: vi.fn(async (_id: string, days: number) => ({ days, applied: false, canChange: true })),
  removeAlertRule: vi.fn(async () => undefined),
}))

const { default: MonitoringView } = await import('./MonitoringView')

const show = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MonitoringView />
  </QueryClientProvider>,
)

const cluster: ClusterRow = {
  id: 'provisioning-lunorica', name: 'provisioning-lunorica', state: 'warning', reasons: ['the disk is 95% full'],
  numbers: { nodes: 1, cpuShare: 0.3, memoryShare: 0.5, diskShare: 0.95 },
  history: { days: 10, kept: 10, applied: true, canChange: true }, apps: 2, isSystem: true,
}

const overview: Overview = {
  attention: [
    { subject: { kind: 'app', id: 'shop', name: 'Shop' }, state: 'down', reasons: ['it does not answer'] },
    { subject: { kind: 'cluster', id: cluster.id, name: cluster.name }, state: 'warning', reasons: ['the disk is 95% full'] },
  ],
  apps: [
    { id: 'shop', name: 'Shop', clusterId: cluster.id, clusterName: cluster.name, state: 'down', reasons: ['it does not answer'], numbers: { uptimeDay: 0.5 } },
    { id: 'books', name: 'Books', clusterId: cluster.id, clusterName: cluster.name, state: 'ok', reasons: [], numbers: { uptimeDay: 1, responseSeconds: 0.2, requestsPerSecond: 3 }, memoryShare: 0.1, cpuShare: 0.02 },
  ],
  clusters: [cluster],
  firing: [{ key: 'k', name: 'AppProbeDown', summary: 'Shop is not answering', about: { kind: 'app', deploymentId: 'shop' }, severity: 'warning', clusterId: cluster.id }],
  checkedAt: new Date().toISOString(),
}

const appView: AppHealthView = {
  app: overview.apps[1]!,
  lines: ['Books is healthy.', 'Its requests are not counted on this cluster yet.'],
  range: '24h',
  series: [{ chart: 'up', points: [[1, 1]] }, { chart: 'memoryShare', points: [[1, 0.1]] }],
  markers: [{ at: new Date().toISOString(), label: 'deployed abcdef12' }],
  firing: [],
  episodes: [{ id: 'e1', clusterId: cluster.id, key: 'k', name: 'AppProbeDown', summary: 'Books is not answering', about: { kind: 'app', deploymentId: 'books' }, startedAt: new Date(Date.now() - 3_600_000).toISOString(), resolvedAt: new Date().toISOString() }],
  rules: [{ id: 'r1', deploymentId: 'books', clusterId: cluster.id, appName: 'Books', summary: 'Books: Books has not answered for 5 minutes', spec: { kind: 'down', threshold: 0, forMinutes: 5 }, createdAt: 'then' }],
  history: { days: 10, kept: 10, applied: true, canChange: true },
}

describe('the Monitoring page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete params.kind
    delete params.id
    vi.mocked(monitoringApi.getOverview).mockResolvedValue(overview)
    vi.mocked(monitoringApi.getAlerts).mockResolvedValue({ firing: overview.firing, episodes: [], rules: appView.rules })
    vi.mocked(monitoringApi.getAppHealth).mockResolvedValue(appView)
    vi.mocked(monitoringApi.getClusterHealth).mockResolvedValue({ cluster, lines: ['provisioning-lunorica needs attention: the disk is 95% full.'], range: '24h', series: [{ chart: 'diskShare', points: [[1, 0.95]] }], firing: [], episodes: [], apps: overview.apps })
  })

  it('puts what needs attention first, each opening its health', async () => {
    show()
    const attention = await screen.findByRole('list', { name: 'Needs attention' })
    const links = within(attention).getAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['#/monitoring/app/shop', '#/monitoring/cluster/provisioning-lunorica'])
    expect(within(attention).getByText('it does not answer')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Firing alerts' })).toHaveTextContent('Shop is not answering')
  })

  it('lists every app worst first with its numbers, and each cluster with its use', async () => {
    show()
    const rows = await screen.findAllByTestId('monitoring-app-row')
    expect(rows.map((row) => within(row).getAllByRole('link')[0]?.textContent)).toEqual(['Shop', 'Books'])
    expect(rows[1]).toHaveTextContent('200 ms')
    expect(rows[1]).toHaveTextContent('3.0/s')
    const card = screen.getByTestId('monitoring-cluster-card')
    expect(within(card).getByRole('meter', { name: 'Disk' })).toHaveAttribute('aria-valuenow', '95')
    expect(card).toHaveTextContent('10 days kept')
  })

  it('says everything is healthy when nothing needs attention', async () => {
    vi.mocked(monitoringApi.getOverview).mockResolvedValue({ ...overview, attention: [], firing: [] })
    show()
    expect(await screen.findByText('Everything is healthy.')).toBeInTheDocument()
  })

  it('shows one app\'s health: what Koala reads, its charts, its alerts, and removes a rule after a confirm', async () => {
    params.kind = 'app'
    params.id = 'books'
    show()
    expect(await screen.findByText('Books is healthy.')).toBeInTheDocument()
    expect(screen.getByText('Its requests are not counted on this cluster yet.')).toBeInTheDocument()
    expect(screen.getByRole('figure', { name: 'Answering' })).toBeInTheDocument()
    expect(screen.getByRole('figure', { name: 'Memory, of its limit' })).toBeInTheDocument()
    expect(screen.getByText('Dashed lines: deployed abcdef12.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open in Grafana/ })).toHaveAttribute('href', expect.stringContaining('/clusters/provisioning-lunorica/proxy/grafana/'))
    expect(screen.getByRole('list', { name: 'Alert history' })).toHaveTextContent('Books is not answering')

    fireEvent.click(screen.getByRole('button', { name: /Remove/ }))
    expect(monitoringApi.removeAlertRule).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove it' }))
    await waitFor(() => expect(monitoringApi.removeAlertRule).toHaveBeenCalledWith('r1'))
  })

  it('asks for another range when one is picked', async () => {
    params.kind = 'app'
    params.id = 'books'
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Week' }))
    await waitFor(() => expect(monitoringApi.getAppHealth).toHaveBeenCalledWith('books', '7d'))
  })

  it('lets whoever owns a cluster change how long it keeps history, and nobody else', async () => {
    params.kind = 'cluster'
    params.id = cluster.id
    const { unmount } = show()
    const days = await screen.findByRole('spinbutton', { name: 'Days of history' })
    fireEvent.change(days, { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(monitoringApi.setHistoryDays).toHaveBeenCalledWith(cluster.id, 30))
    unmount()

    vi.mocked(monitoringApi.getClusterHealth).mockResolvedValue({ cluster: { ...cluster, history: { ...cluster.history, canChange: false } }, lines: [], range: '24h', series: [], firing: [], episodes: [], apps: [] })
    show()
    expect(await screen.findByText('Only whoever owns this cluster can change it.')).toBeInTheDocument()
    expect(screen.queryByRole('spinbutton')).toBeNull()
  })
})
