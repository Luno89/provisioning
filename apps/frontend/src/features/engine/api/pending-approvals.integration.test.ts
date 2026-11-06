import { describe, expect, expectTypeOf, it } from 'vitest'
import { type PendingApproval, decideApproval, listPendingApprovals } from './pending-approvals'
import { startBackend } from '../../../test/backend/site'
import { mountEngine } from '../../../test/backend/engine'
import type { Wire } from '../../../test/backend/wire'
import type { PendingApprovalMetadata } from '../../../../../backend/src/platform/lib/types'

const backend = await startBackend((site) => { mountEngine(site) })
const owner = await backend.signIn()
const now = new Date().toISOString()
await backend.db.infrastructure.savePendingApproval({ id: 'ask-1', ownerId: owner.id, leafId: 'leaf-1', command: 'rm -rf build', status: 'pending', createdAt: now })
await backend.db.infrastructure.savePendingApproval({ id: 'ask-other', ownerId: 'someone-else', leafId: 'leaf-2', command: 'ls', status: 'pending', createdAt: now })

describe('the shapes the browser reads are the shapes the backend sends', () => {
  it('reads a pending approval as the backend describes one', () => {
    expectTypeOf<Wire<PendingApprovalMetadata>>().toExtend<PendingApproval>()
  })
})

describe('commands waiting for the person, as the browser asks for them', () => {
  it('lists only the person\'s own pending commands', async () => {
    expect(await listPendingApprovals()).toEqual([{ id: 'ask-1', ownerId: owner.id, leafId: 'leaf-1', command: 'rm -rf build', status: 'pending', createdAt: now }])
  })

  it('decides one, which then leaves the list, and refuses to decide it twice', async () => {
    expect(await decideApproval('ask-1', 'denied')).toEqual({ success: true })
    expect(await listPendingApprovals()).toEqual([])
    await expect(decideApproval('ask-1', 'approved')).rejects.toMatchObject({ response: { status: 409, data: { error: 'Already decided' } } })
  })

  it('answers 404 for someone else\'s command', async () => {
    await expect(decideApproval('ask-other', 'approved')).rejects.toMatchObject({ response: { status: 404, data: { error: 'Approval not found' } } })
  })
})
