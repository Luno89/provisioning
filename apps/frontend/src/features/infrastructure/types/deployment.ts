export type AppListing = { checked: true; onCluster: boolean } | { checked: false; why: string }

export interface Deployment {
  id: string
  name: string
  appType: string
  clusterId: string
  status: string
  failure?: string
  healthReason?: string
  deployNotes?: string[]
  listing?: AppListing
  strategy?: string
  modules?: string[]

  isExposed?: boolean
  exposureUrl?: string
  isExposedPublicly?: boolean
  publicExposureUrl?: string
  exposurePath?: string
  isExposedLocally?: boolean
  localExposureUrl?: string
  url?: string

  webRepo?: string
  webTag?: string
  dbRepo?: string
  dbTag?: string

  lastLogPath?: string
  temporalWorkflowId?: string
  storage?: Record<string, unknown>

  vllmModel?: string
  tabbyModel?: string
  vpnEnabled?: boolean
  vpnProtocol?: string
  appSettings?: Record<string, string>

  [key: string]: unknown
}
