/**
 * ── DUPLICATED, KNOWINGLY ──
 *
 * The authority is `DeploymentMetadata` in `apps/backend/src/lib/types.ts`. If this disagrees with
 * it, the backend is right.
 *
 * ── WHY THE INDEX SIGNATURE IS HONEST HERE ──
 * A live deployment record carries 66 fields, and roughly fifty of them are per-app-type
 * configuration: `tabbyMaxSeqLen`, `vllmToolCallParser`, `quickwitS3Endpoint`,
 * `webuiWebSearchEngine`, and so on. They are genuinely a heterogeneous bag — which keys exist
 * depends entirely on `appType`, and no record ever has more than a handful of them.
 *
 * Listing all 66 would make this a second copy of the backend record rather than a description of
 * what the UI needs, and it would go stale the first time an app type gained a setting. So the
 * fields every deployment has are named, and the rest are reachable but untyped — a deliberate
 * boundary, not a shrug. A screen that starts depending on one of them should promote it up here.
 */
export interface Deployment {
  id: string
  name: string
  appType: string
  clusterId: string
  status: string
  /** Why the status is what it is, when it is not healthy. */
  healthReason?: string
  strategy?: string
  modules?: string[]

  /** Public exposure, via Localtunnel or an ingress. */
  isExposed?: boolean
  exposureUrl?: string
  exposurePath?: string
  /** Reachable on the host without leaving the machine. */
  isExposedLocally?: boolean
  localExposureUrl?: string
  /** Whatever the card links to — set for app types that serve a web UI. */
  url?: string

  webRepo?: string
  webTag?: string
  dbRepo?: string
  dbTag?: string

  lastSyncedAt?: string
  lastLogPath?: string
  temporalWorkflowId?: string
  storage?: Record<string, unknown>

  /**
   * Promoted out of the bag below because a screen renders them: the model pickers show which model
   * a running vLLM or TabbyAPI deployment is serving, and the apps table shows the VPN badge. That
   * is the rule this boundary exists to enforce — depending on a field means naming it.
   */
  vllmModel?: string
  tabbyModel?: string
  vpnEnabled?: boolean

  /** Per-app-type configuration. See the note above on why this is not enumerated. */
  [key: string]: unknown
}
