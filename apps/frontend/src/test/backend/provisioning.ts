import { Router, type Request } from 'express'
import { PROVISIONING_CHANGED, type ProvisionTarget } from '@koala/engine-core/koala-install'
import type { MachineProgress } from '@koala/engine-core/machine-progress'
import type { Site } from './site'
import { asyncRoute } from '../../../../backend/src/platform/middleware/async-route'
import { userRoom } from '../../../../backend/src/engine-host/temporal/stream-worker'
import {
  openedRecord, pieceHeard, provisioningView, provisionRunId, startDecision, type ProvisioningRecord,
} from '../../../../backend/src/infrastructure/lib/provisioning'

export interface ProvisioningStandIn {
  open: (ownerId: string, target: ProvisionTarget, revision: number) => ProvisioningRecord
  heard: (recordId: string, progress: MachineProgress) => ProvisioningRecord
  asked: () => ProvisioningRecord[]
}

const userOf = (req: Request): { id: string } => (req as unknown as { user: { id: string } }).user

export function mountProvisioningStandIn(site: Site): ProvisioningStandIn {
  const records: ProvisioningRecord[] = []
  const asked: ProvisioningRecord[] = []
  let stamp = 0
  const changed = (ownerId: string) => { site.io.to(userRoom(ownerId)).emit(PROVISIONING_CHANGED, {}) }
  const latestPerCluster = (ownerId: string): ProvisioningRecord[] => {
    const mine = records.filter((record) => record.ownerId === ownerId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    return mine.filter((record, index) => mine.findIndex((other) => other.target.clusterId === record.target.clusterId) === index)
  }

  const start = (ownerId: string, target: ProvisionTarget, revision: number, reason: ProvisioningRecord['reason']): ProvisioningRecord => {
    const decision = startDecision(records, target, revision, reason)
    if (!decision.start) return 'running' in decision ? decision.running : decision.already
    stamp += 1
    const record = openedRecord({ ownerId, target, revision, reason, runId: provisionRunId(target.clusterId, String(stamp)), at: new Date(Date.UTC(2026, 10, 18, 10, stamp)).toISOString() })
    records.push(record)
    changed(ownerId)
    return record
  }

  const router = Router()
  router.get('/', asyncRoute(async (req, res) => {
    res.json({ setups: latestPerCluster(userOf(req).id).map(provisioningView), can: ['set-up-again'] })
  }))
  router.post('/again', asyncRoute(async (req, res) => {
    const ownerId = userOf(req).id
    const clusterId = (req.body as { clusterId?: unknown }).clusterId
    const last = latestPerCluster(ownerId).find((record) => record.target.clusterId === clusterId)
    if (!last) return void res.status(404).json({ error: 'Koala sets up nothing by that name' })
    const record = start(ownerId, last.target, last.revision, 'asked')
    asked.push(record)
    res.status(202).json(provisioningView(record))
  }))
  site.api.use('/infrastructure/provisioning', router)

  return {
    open: (ownerId, target, revision) => start(ownerId, target, revision, 'revision'),
    heard: (recordId, progress) => {
      const index = records.findIndex((record) => record.id === recordId)
      if (index < 0) throw new Error(`no setup ${recordId}`)
      const record = pieceHeard(records[index]!, progress, new Date().toISOString())
      records[index] = record
      changed(record.ownerId)
      return record
    },
    asked: () => [...asked],
  }
}
