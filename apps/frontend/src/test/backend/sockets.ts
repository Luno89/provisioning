import { afterAll } from 'vitest'
import type { Site } from './site'
import { outsideThisTier } from './outside'
import { disconnectShared, getSocket, reconnectSocket } from '../../features/platform'
import { wireSockets, type SocketsWiringDeps } from '../../../../backend/src/machines/wiring/sockets'
import { SessionSockets } from '../../../../backend/src/platform/services/SessionSockets'
import { testPayloadBlobs } from '../../../../backend/src/platform/lib/test-database'
import { testKeys } from '../../../../backend/src/platform/testing/keys'
import type { RoleConfig } from '../../../../backend/src/platform/lib/platform-role'

export interface PageSockets {
  open: () => Promise<void>
}

export type PageSocketsReach = Partial<Pick<SocketsWiringDeps, 'machines' | 'clusters' | 'apps'>>

export function pageSocketsOf({ db, io, auth }: Site, role: RoleConfig, reach: PageSocketsReach = {}): PageSockets {
  const keys = testKeys('frontend-integration-sockets')
  wireSockets({
    io, db, role, auth, sessionSockets: new SessionSockets(),
    payloadBlobs: testPayloadBlobs().blobs, payloadKey: keys.payload, dataKey: keys.data,
    machines: reach.machines ?? outsideThisTier('the machines a page socket never reaches'),
    clusters: reach.clusters ?? outsideThisTier('the clusters a page socket never reaches'),
    apps: reach.apps ?? outsideThisTier('the apps a page socket never reaches'),
    telemetry: outsideThisTier('machine telemetry'),
  })
  afterAll(() => { disconnectShared() })
  const open = (): Promise<void> => new Promise<void>((resolve, reject) => {
    const socket = getSocket()
    if (socket.connected) return resolve()
    const opened = () => { socket.off('connect_error', refused); resolve() }
    const refused = (err: Error) => { socket.off('connect', opened); reject(new Error(`the page's socket was refused: ${err.message}`)) }
    socket.once('connect', opened)
    socket.once('connect_error', refused)
    reconnectSocket()
  })
  return { open }
}
