import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as monitoringApi from '../../api/monitoring'
import * as infrastructureApi from '../../api/infrastructure'
import * as runningApi from '../../api/running'
import * as clustersApi from '../../api/clusters'
import type { AppHealthView, ClusterRow, Overview } from '../../api/monitoring'
import type { ClusterContents, InfrastructureOverview } from '../../api/infrastructure'
import { ShellContextInstance, type ShellContext } from '../shell-context'
import { useShellStore } from '../../stores/shell'

const params: { tab?: string; kind?: string; id?: string } = {}
vi.mock('@tanstack/react-router', () => ({ useParams: () => params }))
vi.mock('../Monitoring/Chart', () => ({ Chart: ({ title }: { title: string }) => <figure aria-label={title} /> }))
vi.mock('../../api/monitoring', async (orig) => ({
  ...(await orig<typeof monitoringApi>()),
  getOverview: vi.fn(),
  getAlerts: vi.fn(),
  getAppHealth: vi.fn(),
  getClusterHealth: vi.fn(),
  setHistoryDays: vi.fn(async (_id: string, days: number) => ({ days, applied: false, canChange: true })),
  removeAlertRule: vi.fn(async () => undefined),
}))
vi.mock('../../api/infrastructure', async (orig) => ({
  ...(await orig<typeof infrastructureApi>()),
  getInfrastructure: vi.fn(),
  getClusterContents: vi.fn(),
  clearFailures: vi.fn(async (ids?: string[]) => ids?.length ?? 2),
}))
vi.mock('../../api/running', async (orig) => ({
  ...(await orig<typeof runningApi>()),
  getRunning: vi.fn(async () => ({ items: [{ workflowId: 'run-1', kind: 'chat', title: 'Koala answering', since: new Date().toISOString(), opens: { kind: 'chat', id: 'c1' }, cancel: { via: 'run' } }], bench: { paused: true }, keeper: { paused: false, held: 0 } })),
}))
vi.mock('../../api/clusters', async (orig) => ({
  ...(await orig<typeof clustersApi>()),
  useGpuStatus: () => ({ isPending: false, data: { vendor: 'NVIDIA', hasGpu: true, passthroughEnabled: true, totalCapacity: 2, totalAllocatable: 2, totalAllocated: 1, availableGpus: 1, devicePlugins: [], gpuPods: [] } }),
}))

const { default: InfrastructureView } = await import('./InfrastructureView')

const shell = {
  clusters: [
    { id: 'provisioning-lunorica', name: 'provisioning-lunorica', provider: 'k3s', status: 'healthy', isSystem: true },
    { id: 'c2', name: 'edge', provider: 'hetzner', status: 'healthy' },
  ],
  deployments: [
    { id: 'books', name: 'Books', appType: 'audiobookshelf', clusterId: 'provisioning-lunorica', status: 'running', url: 'http://books.local' },
    { id: 'shop', name: 'Shop', appType: 'odoo', clusterId: 'provisioning-lunorica', status: 'running' },
    { id: 'new', name: 'New', appType: 'wordpress', clusterId: 'c2', status: 'deploying' },
  ],
  providers: [],
  setShowClusterModal: vi.fn(),
  setShowAppModal: vi.fn(),
  setWizardPreset: vi.fn(),
  openDashboard: vi.fn(),
  editorContent: '',
  setEditorContent: vi.fn(),
  loadingNginxConfig: false,
  updateNginxConfig: {},
  vpnDomains: {},
  setVpnDomains: vi.fn(),
  setShowNginxWizard: vi.fn(),
} as unknown as ShellContext

const show = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ShellContextInstance.Provider value={shell}>
      <InfrastructureView />
    </ShellContextInstance.Provider>
  </QueryClientProvider>,
)

const cluster: ClusterRow = {
  id: 'provisioning-lunorica', name: 'provisioning-lunorica', state: 'warning', reasons: ['the disk is 95% full'],
  numbers: { nodes: 1, cpuShare: 0.3, memoryShare: 0.5, diskShare: 0.95 },
  history: { days: 10, kept: 10, applied: true, canChange: true }, apps: 2, isSystem: true,
}

const monitoring: Overview = {
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

const overview: InfrastructureOverview = {
  monitoring,
  workloads: [{ namespace: 'searxng', kind: 'Deployment', name: 'searxng', group: 'other', about: { kind: 'other' }, pods: { total: 1, ready: 0 }, state: 'down', reasons: ['it keeps crashing'], restarts: 12, clusterId: cluster.id, clusterName: cluster.name }],
  waiting: [{ workflowId: 'release-p1', kind: 'release', title: 'Releasing Books: abc12345 waits for you on its card', since: 'then', opens: { kind: 'project', id: 'p1' }, cancel: { via: 'run' }, waitsFor: ['decide'] }],
  running: 3,
  failures: [
    { id: 'run:r1', workflowId: 'r1', kind: 'tree', title: 'Tree run: Shop', opens: { kind: 'tree', id: 't1' }, reason: 'the executor could not start its sandbox', failedAt: new Date(Date.now() - 3_600_000).toISOString() },
    { id: 'run:r2', workflowId: 'r2', kind: 'memory-keeper', title: 'The memory keeper, reading Labels', opens: { kind: 'temporal', id: 'r2' }, reason: 'the model did not answer', failedAt: new Date(Date.now() - 7_200_000).toISOString() },
  ],
}

const contents: ClusterContents = {
  clusterId: cluster.id, readAt: 'now', reachable: true, ownsCluster: true, finishedJobs: 3, measured: true,
  workloads: [
    { namespace: 'shop', kind: 'Deployment', name: 'shop-odoo', group: 'apps', about: { kind: 'app', id: 'shop', name: 'Shop', mine: true }, pods: { total: 1, ready: 1 }, state: 'ok', reasons: [], restarts: 0, memoryBytes: 512 * 1024 ** 2, cpuCores: 0.12 },
    { namespace: 'koala-run-tree-t1', kind: 'Pod', name: 'workspace', group: 'koala', about: { kind: 'tree', id: 't1', mine: true }, pods: { total: 1, ready: 1 }, state: 'ok', reasons: [], restarts: 0 },
    { namespace: 'odoo-browser-failure', kind: 'StatefulSet', name: 'pg', group: 'koala', about: { kind: 'project', id: 'p9', mine: false, check: true }, pods: { total: 1, ready: 1 }, state: 'ok', reasons: [], restarts: 0 },
    { namespace: 'monitoring', kind: 'StatefulSet', name: 'prometheus', group: 'platform', about: { kind: 'platform' }, release: 'kube-prometheus-stack', pods: { total: 1, ready: 1 }, state: 'ok', reasons: [], restarts: 0 },
    { namespace: 'searxng', kind: 'Deployment', name: 'searxng', group: 'other', about: { kind: 'other' }, pods: { total: 1, ready: 0 }, state: 'down', reasons: ['it keeps crashing'], restarts: 12 },
  ],
  services: [
    { key: 'grafana', label: 'Grafana', does: 'dashboards over the same measurements', installed: true, release: { name: 'kube-prometheus-stack', chart: 'kube-prometheus-stack-79.0.0', version: 'v0.86.0', status: 'deployed' }, state: 'ok', reasons: [], pods: { total: 1, ready: 1 }, dashboard: true, access: 'Opens signed in as admin.' },
    { key: 'gitea', label: 'Gitea', does: 'keeps every project\'s repository and builds', installed: false, state: 'absent', reasons: [], pods: { total: 0, ready: 0 }, dashboard: false, access: 'Opens signed in as provisioning-bot.' },
  ],
  releases: [{ name: 'kube-prometheus-stack', namespace: 'monitoring', status: 'deployed', chart: 'kube-prometheus-stack-79.0.0' }, { name: 'loki', namespace: 'monitoring', status: 'failed', chart: 'loki-6.0.0' }],
  nodes: [{ name: 'lunorica', ready: true, roles: ['control-plane'], version: 'v1.33.1+k3s1', cpuCores: 16, memoryBytes: 64 * 1024 ** 3, gpus: 2 }],
}

const appView: AppHealthView = {
  app: monitoring.apps[1]!,
  lines: ['Books is healthy.', 'Its requests are not counted on this cluster yet.'],
  range: '24h',
  series: [{ chart: 'up', points: [[1, 1]] }, { chart: 'memoryShare', points: [[1, 0.1]] }],
  markers: [{ at: new Date().toISOString(), label: 'deployed abcdef12' }],
  firing: [],
  episodes: [{ id: 'e1', clusterId: cluster.id, key: 'k', name: 'AppProbeDown', summary: 'Books is not answering', about: { kind: 'app', deploymentId: 'books' }, startedAt: new Date(Date.now() - 3_600_000).toISOString(), resolvedAt: new Date().toISOString() }],
  rules: [{ id: 'r1', deploymentId: 'books', clusterId: cluster.id, appName: 'Books', summary: 'Books: Books has not answered for 5 minutes', spec: { kind: 'down', threshold: 0, forMinutes: 5 }, createdAt: 'then' }],
  history: { days: 10, kept: 10, applied: true, canChange: true },
}

describe('the Infrastructure page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete params.tab
    delete params.kind
    delete params.id
    useShellStore.setState({ confirmDestroy: null })
    vi.mocked(infrastructureApi.getInfrastructure).mockResolvedValue(overview)
    vi.mocked(infrastructureApi.getClusterContents).mockResolvedValue(contents)
    vi.mocked(monitoringApi.getOverview).mockResolvedValue(monitoring)
    vi.mocked(monitoringApi.getAlerts).mockResolvedValue({ firing: monitoring.firing, episodes: [], rules: appView.rules })
    vi.mocked(monitoringApi.getAppHealth).mockResolvedValue(appView)
    vi.mocked(monitoringApi.getClusterHealth).mockResolvedValue({ cluster, lines: ['provisioning-lunorica needs attention: the disk is 95% full.'], range: '24h', series: [{ chart: 'diskShare', points: [[1, 0.95]] }], firing: [], episodes: [], apps: monitoring.apps })
  })

  it('shows what needs attention, then apps, clusters and what runs, all on the one page', async () => {
    show()
    expect(await screen.findByRole('list', { name: 'Needs attention' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Running · 1' })).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['Needs attention', 'Apps · 3', 'Clusters · 2', 'Your own hardware', 'Running · 1', 'Model traffic', 'Alerts set', 'Alert history'])
    expect(screen.getAllByTestId('app-row')).toHaveLength(3)
    expect(screen.getAllByTestId('cluster-card')).toHaveLength(2)
    expect(await screen.findByRole('link', { name: 'Koala answering' })).toHaveAttribute('href', '#/chat/c1')
    expect(screen.queryByRole('navigation', { name: 'Infrastructure' })).toBeNull()
  })

  it('scrolls to the section an old address names', async () => {
    const scrolled = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrolled
    params.tab = 'running'
    show()
    await waitFor(() => expect(scrolled).toHaveBeenCalled())
    expect(scrolled.mock.contexts[0]).toBe(document.getElementById('infrastructure-running'))
  })

  it('lists work waiting on the person, unhealthy apps and clusters, broken workloads and recent failures in one place', async () => {
    show()
    const attention = await screen.findByRole('list', { name: 'Needs attention' })
    expect(within(attention).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      '#/projects/project/p1',
      '#/infrastructure/app/shop',
      '#/infrastructure/cluster/provisioning-lunorica',
      '#/infrastructure/cluster/provisioning-lunorica',
      '#/projects/tree/t1',
      '#/temporal',
    ])
    expect(within(attention).getByText('waits for your answer')).toBeInTheDocument()
    expect(within(attention).getByTestId('attention-workload')).toHaveTextContent('searxng on provisioning-lunorica')
    expect(within(attention).getAllByTestId('attention-failure')[0]).toHaveTextContent('the executor could not start its sandbox')
    expect(screen.getByRole('list', { name: 'Firing alerts' })).toHaveTextContent('Shop is not answering')
  })

  it('clears one failure, or all of them', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Clear Tree run: Shop' }))
    await waitFor(() => expect(infrastructureApi.clearFailures).toHaveBeenCalledWith(['run:r1']))
    fireEvent.click(screen.getByRole('button', { name: 'Clear all 2 failures' }))
    await waitFor(() => expect(infrastructureApi.clearFailures).toHaveBeenCalledWith(undefined))
  })

  it('says when everything is healthy and nothing waits', async () => {
    vi.mocked(infrastructureApi.getInfrastructure).mockResolvedValue({ ...overview, monitoring: { ...monitoring, attention: [], firing: [] }, workloads: [], waiting: [], failures: [] })
    show()
    expect(await screen.findByText('Everything is healthy, and nothing waits on you.')).toBeInTheDocument()
  })

  it('lists every app with its health, deploys a new one, and manages or destroys each', async () => {
    show()
    await waitFor(() => expect(screen.getAllByTestId('app-row')[0]).toHaveTextContent('Shop'))
    const rows = screen.getAllByTestId('app-row')
    expect(rows.map((row) => within(row).getAllByRole('link')[0]?.textContent)).toEqual(['Shop', 'Books', 'New'])
    expect(rows[1]).toHaveTextContent('200 ms')
    expect(rows[1]).toHaveTextContent('3.0/s')
    expect(within(rows[1]!).getByRole('link', { name: /Open/ })).toHaveAttribute('href', 'http://books.local')
    expect(rows[2]).toHaveTextContent('deploying')
    fireEvent.click(screen.getByRole('button', { name: /Deploy an app/ }))
    expect(shell.setShowAppModal).toHaveBeenCalledWith(true)
    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Manage Books' }))
    expect(shell.openDashboard).toHaveBeenCalledWith('app', 'books')
    fireEvent.click(within(rows[2]!).getByRole('button', { name: 'Destroy New' }))
    expect(useShellStore.getState().confirmDestroy).toEqual({ type: 'app', id: 'new', name: 'New', isAbort: true })
  })

  it('lists every cluster, provisions a new one, and keeps the system cluster read-only', async () => {
    show()
    const cards = await screen.findAllByTestId('cluster-card')
    expect(cards.map((card) => within(card).getAllByRole('link')[0]?.textContent)).toEqual(['provisioning-lunorica', 'edge'])
    await waitFor(() => expect(within(cards[0]!).getByRole('meter', { name: 'Disk' })).toHaveAttribute('aria-valuenow', '95'))
    expect(within(cards[0]!).queryByRole('button')).toBeNull()
    fireEvent.click(within(cards[1]!).getByRole('button', { name: 'Logs of edge' }))
    expect(shell.openDashboard).toHaveBeenCalledWith('cluster', 'c2')
    fireEvent.click(within(cards[1]!).getByRole('button', { name: 'Destroy edge' }))
    expect(useShellStore.getState().confirmDestroy).toMatchObject({ type: 'cluster', id: 'c2' })
    fireEvent.click(screen.getByRole('button', { name: /Provision a cluster/ }))
    expect(shell.setShowClusterModal).toHaveBeenCalledWith(true)
  })

  it('shows everything on a cluster: workloads by whose they are, platform services, nodes, GPUs and Helm releases', async () => {
    params.kind = 'cluster'
    params.id = cluster.id
    show()
    const apps = await screen.findByTestId('workload-group-apps')
    expect(within(apps).getByRole('link', { name: 'Shop' })).toHaveAttribute('href', '#/infrastructure/app/shop')
    expect(within(apps).getByText('512 MB')).toBeInTheDocument()
    const koala = screen.getByTestId('workload-group-koala')
    expect(within(koala).getByRole('link', { name: 'its tree' })).toHaveAttribute('href', '#/projects/tree/t1')
    expect(koala).toHaveTextContent('left by a check, its project')
    const platform = screen.getByTestId('workload-group-platform')
    expect(within(platform).queryByTestId('workload-row')).toBeNull()
    fireEvent.click(within(platform).getByRole('button'))
    expect(within(platform).getByText('prometheus')).toBeInTheDocument()
    const other = screen.getByTestId('workload-group-other')
    expect(within(other).getByText('it keeps crashing')).toBeInTheDocument()
    expect(screen.getByText(/3 finished jobs not shown/)).toBeInTheDocument()

    const services = screen.getAllByTestId('platform-service')
    expect(within(services[0]!).getByRole('link', { name: /Open dashboard/ })).toHaveAttribute('href', expect.stringContaining('/clusters/provisioning-lunorica/proxy/grafana/'))
    expect(services[1]).toHaveTextContent('Not installed')
    expect(services[0]).toHaveTextContent('Opens signed in as admin.')
    expect(screen.getByRole('link', { name: 'Local router (Nginx)' })).toHaveAttribute('href', '#/nginx')
    expect(screen.getByTestId('node-row')).toHaveTextContent('Readylunorica')
    expect(screen.getByTestId('node-row')).toHaveTextContent('16 CPU · 64 GB · 2 GPU')
    expect(screen.getByTestId('gpu-panel')).toHaveTextContent('1 of 2 free')
    expect(screen.getByText('loki is failed')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '← Clusters' })).toHaveAttribute('href', '#/infrastructure/clusters')
  })

  it('shows someone else\'s view of a cluster without its services, nodes, GPUs or releases', async () => {
    params.kind = 'cluster'
    params.id = cluster.id
    const { services: _services, nodes: _nodes, releases: _releases, ...theirs } = contents
    vi.mocked(infrastructureApi.getClusterContents).mockResolvedValue({ ...theirs, ownsCluster: false, workloads: contents.workloads.slice(0, 1) })
    show()
    expect(await screen.findByTestId('workload-group-apps')).toBeInTheDocument()
    expect(screen.queryByTestId('platform-service')).toBeNull()
    expect(screen.queryByTestId('node-row')).toBeNull()
    expect(screen.queryByTestId('gpu-panel')).toBeNull()
  })

  it('shows one app\'s health: what Koala reads, its charts, its alerts, and removes a rule after a confirm', async () => {
    params.kind = 'app'
    params.id = 'books'
    show()
    expect(await screen.findByText('Books is healthy.')).toBeInTheDocument()
    expect(screen.getByRole('figure', { name: 'Answering' })).toBeInTheDocument()
    expect(screen.getByText('Dashed lines: deployed abcdef12.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open in Grafana/ })).toHaveAttribute('href', expect.stringContaining('/clusters/provisioning-lunorica/proxy/grafana/'))
    expect(screen.getByRole('list', { name: 'Alert history' })).toHaveTextContent('Books is not answering')
    expect(screen.getByRole('link', { name: /Infrastructure/ })).toHaveAttribute('href', '#/infrastructure')
    expect(screen.getByRole('link', { name: '← Apps' })).toHaveAttribute('href', '#/infrastructure/apps')
    fireEvent.click(screen.getByRole('button', { name: /Manage/ }))
    expect(shell.openDashboard).toHaveBeenCalledWith('app', 'books')

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

  it('offers Grafana only to whoever owns the cluster, on the cluster and on an app on it', async () => {
    const notOwned = { ...cluster.history, canChange: false }
    params.kind = 'cluster'
    params.id = cluster.id
    vi.mocked(monitoringApi.getClusterHealth).mockResolvedValue({ cluster: { ...cluster, history: notOwned }, lines: [], range: '24h', series: [], firing: [], episodes: [], apps: [] })
    const { unmount } = show()
    expect(await screen.findByText('Only whoever owns this cluster can change it.')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Open in Grafana/ })).toBeNull()
    unmount()

    params.kind = 'app'
    params.id = 'books'
    vi.mocked(monitoringApi.getAppHealth).mockResolvedValue({ ...appView, history: notOwned })
    show()
    expect(await screen.findByText('Books is healthy.')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Open in Grafana/ })).toBeNull()
  })

  it('on Koala\'s servers, says root keeps the history and offers no Grafana, for the cluster and its apps', async () => {
    const byKoala = { days: 10, kept: 10, applied: true, canChange: false, byKoala: true }
    params.kind = 'cluster'
    params.id = cluster.id
    vi.mocked(monitoringApi.getClusterHealth).mockResolvedValue({ cluster: { ...cluster, history: byKoala }, lines: [], range: '24h', series: [], firing: [], episodes: [], apps: [] })
    const { unmount } = show()
    expect(await screen.findByText('Koala\'s servers watch this cluster and keep 10 days of its measurements.')).toBeInTheDocument()
    expect(screen.queryByRole('spinbutton')).toBeNull()
    expect(screen.queryByRole('link', { name: /Open in Grafana/ })).toBeNull()
    unmount()

    params.kind = 'app'
    params.id = 'books'
    vi.mocked(monitoringApi.getAppHealth).mockResolvedValue({ ...appView, history: byKoala })
    show()
    expect(await screen.findByText('Books is healthy.')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Open in Grafana/ })).toBeNull()
  })
})
