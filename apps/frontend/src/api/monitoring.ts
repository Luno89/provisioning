import { api } from './client'

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: apps/backend/src/services/MonitoringService.ts (Overview, AppHealthView, ClusterHealthView),
 * apps/backend/src/lib/monitoring-summary.ts (HealthState, AppNumbers, ClusterNumbers),
 * apps/backend/src/lib/monitoring-alerts.ts (VisibleAlert, AlertRuleRecord) and
 * apps/backend/src/lib/monitoring-records.ts (AlertEpisode).
 */
export type HealthState = 'ok' | 'warning' | 'down' | 'unreachable' | 'installing'
export type Range = '1h' | '24h' | '7d' | '30d'
export const RANGES: Range[] = ['1h', '24h', '7d', '30d']

export interface AppNumbers {
  probed?: number
  up?: number
  responseSeconds?: number
  podsRunning?: number
  podsBroken?: number
  memoryBytes?: number
  memoryLimitBytes?: number
  cpuCores?: number
  cpuLimitCores?: number
  volumeShare?: number
  requestsPerSecond?: number
  errorShare?: number
  uptimeDay?: number
  uptimeWeek?: number
  uptimeKept?: number
  restartsDay?: number
}

export interface ClusterNumbers {
  nodes?: number
  nodesNotReady?: number
  cpuShare?: number
  memoryShare?: number
  diskShare?: number
  podsPending?: number
  podsBroken?: number
}

export interface HistoryState {
  days: number
  kept?: number
  applied: boolean
  problem?: string
  canChange: boolean
  byKoala?: boolean
}

export interface AppRow {
  id: string
  name: string
  appType?: string
  clusterId: string
  clusterName: string
  state: HealthState
  reasons: string[]
  numbers: AppNumbers
  memoryShare?: number
  cpuShare?: number
  url?: string
}

export interface ClusterRow {
  id: string
  name: string
  state: HealthState
  reasons: string[]
  numbers: ClusterNumbers
  history: HistoryState
  apps: number
  isSystem: boolean
}

export type AlertAbout = { kind: 'app'; deploymentId: string } | { kind: 'cluster' }

export interface FiringAlert {
  key: string
  name: string
  summary: string
  about: AlertAbout
  ruleId?: string
  since?: string
  severity: string
  clusterId?: string
}

export interface AlertEpisode {
  id: string
  clusterId: string
  key: string
  name: string
  summary: string
  about: AlertAbout
  ruleId?: string
  startedAt: string
  resolvedAt?: string
}

export interface AlertRule {
  id: string
  deploymentId: string
  clusterId: string
  appName: string
  summary: string
  spec: { kind: string; threshold: number; forMinutes: number }
  createdAt: string
}

export interface Attention {
  subject: { kind: 'app' | 'cluster'; id: string; name: string }
  state: HealthState
  reasons: string[]
}

export interface Overview {
  attention: Attention[]
  apps: AppRow[]
  clusters: ClusterRow[]
  firing: FiringAlert[]
  checkedAt: string
}

export interface Series {
  chart: string
  points: Array<[number, number]>
}

export interface Marker {
  at: string
  label: string
}

export interface AppHealthView {
  app: AppRow
  lines: string[]
  range: Range
  series: Series[]
  markers: Marker[]
  firing: FiringAlert[]
  episodes: AlertEpisode[]
  rules: AlertRule[]
  history: HistoryState
}

export interface ClusterHealthView {
  cluster: ClusterRow
  lines: string[]
  range: Range
  series: Series[]
  firing: FiringAlert[]
  episodes: AlertEpisode[]
  apps: AppRow[]
}

export interface AlertsView {
  firing: FiringAlert[]
  episodes: AlertEpisode[]
  rules: AlertRule[]
}

export const monitoringKeys = {
  all: () => ['monitoring'] as const,
  overview: () => ['monitoring', 'overview'] as const,
  alerts: () => ['monitoring', 'alerts'] as const,
  app: (id: string, range: Range) => ['monitoring', 'app', id, range] as const,
  cluster: (id: string, range: Range) => ['monitoring', 'cluster', id, range] as const,
}

export async function getOverview(): Promise<Overview> {
  return (await api.get<Overview>('/monitoring')).data
}

export async function getAlerts(): Promise<AlertsView> {
  return (await api.get<AlertsView>('/monitoring/alerts')).data
}

export async function getAppHealth(id: string, range: Range): Promise<AppHealthView> {
  return (await api.get<AppHealthView>(`/monitoring/apps/${encodeURIComponent(id)}`, { params: { range } })).data
}

export async function getClusterHealth(id: string, range: Range): Promise<ClusterHealthView> {
  return (await api.get<ClusterHealthView>(`/monitoring/clusters/${encodeURIComponent(id)}`, { params: { range } })).data
}

export async function setHistoryDays(clusterId: string, days: number): Promise<HistoryState> {
  return (await api.put<HistoryState>(`/monitoring/clusters/${encodeURIComponent(clusterId)}/history`, { days })).data
}

export async function removeAlertRule(id: string): Promise<void> {
  await api.delete(`/monitoring/rules/${encodeURIComponent(id)}`)
}
