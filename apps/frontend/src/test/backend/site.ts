import http from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import express, { type Router } from 'express'
import { Server as SocketServer } from 'socket.io'
import { afterAll } from 'vitest'
import type { Auth } from '../../../../backend/src/platform/middleware/auth'
import { rootAuthOver } from '../../../../backend/src/platform/testing/root-auth'
import { errorResponder } from '../../../../backend/src/platform/middleware/async-route'
import { refuseWorkOfDeletingProjects } from '../../../../backend/src/projects/wiring/deleting-refusals'
import { AccessRevocations } from '../../../../backend/src/platform/services/AccessRevocations'
import { testDatabase } from '../../../../backend/src/platform/lib/test-database'
import { JSON_LIMITS } from '../../../../backend/src/platform/lib/http-limits'
import type { Database } from '../../../../backend/src/platform/lib/db-interface'
import { authRouter } from '../../../../backend/src/accounts/routes/auth'
import { passwordRouter } from '../../../../backend/src/accounts/routes/password'
import { devicesFor } from '../../../../backend/src/accounts/routes/device'
import { AuthService } from '../../../../backend/src/accounts/services/AuthService'
import { PasswordService } from '../../../../backend/src/accounts/services/PasswordService'
import { loadBreachedPasswords } from '../../../../backend/src/accounts/services/breached-passwords'
import { newInviteCode, inviteCodeHash, inviteExpiry } from '../../../../backend/src/platform/lib/invite-codes'
import { seedAll } from '../../../../backend/src/scripts/seed-all'
import { getMe, login, verifySignUp, type SessionUser } from '../../features/platform'
import { openRoutesOf } from '../../../../backend/src/open-routes'
import { InstanceReach } from '../../../../backend/src/instances/services/InstanceReach'
import { SESSION_ID_COOKIE, servedThroughRoot, signInThroughRoot, type Served } from '../../../../backend/src/instances/testing/through-root'

export const SESSION_KEY = 'frontend-integration-session-key'
export const CODE_KEY = 'frontend-integration-code-key'
export const SETUP_CODE = 'frontend-integration-setup-code'
export const PASSWORD = 'a frontend integration password'

export interface Site {
  db: Database
  api: Router
  auth: Auth
  origin: string
  io: SocketServer
}

export interface Mail {
  to: string
  subject: string
  text: string
}

export interface Root extends Served {
  db: Database
}

export interface Backend {
  db: Database
  origin: string
  rootUrl: string
  mailbox: Mail[]
  signIn: (email?: string) => Promise<SessionUser>
  signInAnother: (email: string) => Promise<SessionUser>
  turnedAway: (email: string) => Promise<string>
  invite: () => Promise<string>
  codeMailedTo: (email: string) => string
}

interface Page {
  reconfigure: (settings: { url: string }) => void
  window: { _origin: string }
  cookieJar: { setCookieSync: (cookie: string, url: string) => unknown }
}

const thePage = (): Page => {
  const dom = (globalThis as { jsdom?: Page }).jsdom
  if (!dom) throw new Error('the frontend integration tier runs in jsdom, whose page has to move to the backend it talks to')
  return dom
}

const moveThePageTo = (origin: string): void => {
  const dom = thePage()
  dom.reconfigure({ url: `${origin}/` })
  dom.window._origin = origin
}

const INSTANCE_OWNER = 'owner-1'
export const INSTANCE_ID = 'inst-frontend'

const listening = async (app: express.Express): Promise<{ server: http.Server; url: string }> => {
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()) }))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

const ownRoot = async (): Promise<Root> => {
  const app = express()
  return { app, url: (await listening(app)).url, db: await testDatabase() }
}

export async function startBackend(mount: (site: Site) => void | Promise<void>, options: { role?: 'root' | 'instance'; root?: Root } = {}): Promise<Backend> {
  const asInstance = options.role === 'instance'
  let people = 0
  const db = await testDatabase()
  await seedAll(db)
  const app = express()
  const server = http.createServer(app)
  const io = new SocketServer(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  afterAll(() => new Promise<void>((resolve) => { void io.close(() => resolve()) }))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const revocations = new AccessRevocations()
  const root = asInstance ? options.root ?? await ownRoot() : undefined
  const throughRoot = root
    ? await servedThroughRoot({
      rootDb: root.db, instanceDb: db, root, instance: { url: origin, app }, reach: new InstanceReach({ open: true }),
      instanceId: INSTANCE_ID, ownerId: INSTANCE_OWNER, revocations,
      dependency: { failed: (_dependency, err) => err },
    })
    : undefined
  if (throughRoot) await throughRoot.signIn.register()
  const auth = throughRoot
    ? throughRoot.instanceAuth
    : rootAuthOver(db, { publicUrl: origin, open: openRoutesOf('root'), setupCode: SETUP_CODE, revocations }).auth
  const mailbox: Mail[] = []
  const authService = new AuthService(db, { codeKey: CODE_KEY, mail: { available: () => ({ ok: true }), toAddress: async (to, message) => { mailbox.push({ to, ...message }) } } })
  const passwords = new PasswordService({ db, codeKey: CODE_KEY, auth: authService, breached: loadBreachedPasswords(), revocations })
  const devices = devicesFor({ auth, sessionKey: SESSION_KEY, authService })

  app.use('/api', auth.requireAuth)
  app.use(express.json({ limit: JSON_LIMITS.signedIn }))
  app.use('/api/auth', authRouter({ db, authService, auth, sessionKey: SESSION_KEY, codeKey: CODE_KEY, appUrl: origin, accounts: !asInstance, revocations, passwords }))
  if (!asInstance) app.use('/api/auth/password', passwordRouter({ passwords, auth, devices }))
  refuseWorkOfDeletingProjects(app, db)
  const api = express.Router()
  app.use('/api', api)
  await mount({ db, api, auth, origin, io })
  app.use(errorResponder)

  moveThePageTo(origin)

  const signIn = async (email = 'owner@koala.test'): Promise<SessionUser> => {
    if (root && throughRoot) {
      const person = { id: email === 'owner@koala.test' ? INSTANCE_OWNER : `person-${(people += 1)}`, email }
      await root.db.accounts.saveUser({ ...person, emailVerified: true, twoFactorEnabled: false, createdAt: new Date().toISOString() })
      const { instanceJar, landed } = await signInThroughRoot(root.url, origin, await throughRoot.signInAtRoot(person))
      const held = instanceJar.get(SESSION_ID_COOKIE)
      if (!held) throw new Error(`signing ${email} in through root ended on ${landed.status} at ${landed.url}: ${await landed.text()}`)
      thePage().cookieJar.setCookieSync(`${SESSION_ID_COOKIE}=${held}; Path=/; HttpOnly; SameSite=Lax`, `${origin}/`)
      const me = await getMe()
      if (!me) throw new Error(`the instance did not take ${email}'s session from root`)
      return me
    }
    if ((await db.accounts.getUsers()).length === 0) await login({ email, password: PASSWORD, inviteCode: SETUP_CODE }, { register: true })
    const signedIn = await login({ email, password: PASSWORD })
    if (!signedIn.user) throw new Error(`signing in as ${email} answered ${JSON.stringify(signedIn)}`)
    return signedIn.user
  }

  const invite = async (): Promise<string> => {
    const code = newInviteCode()
    await db.accounts.saveInvite({ id: randomUUID(), codeHash: inviteCodeHash(code), createdBy: 'frontend-integration', createdAt: new Date().toISOString(), expiresAt: inviteExpiry(new Date()) })
    return code
  }

  const codeMailedTo = (email: string): string => {
    const code = mailbox.filter((mail) => mail.to === email).at(-1)?.text.match(/\b\d{6}\b/)?.[0]
    if (!code) throw new Error(`no code was mailed to ${email}`)
    return code
  }

  const turnedAway = async (email: string): Promise<string> => {
    if (!root || !throughRoot) throw new Error('only an instance turns people away at root; root itself signs up anyone it invites')
    const person = { id: `person-${(people += 1)}`, email }
    await root.db.accounts.saveUser({ ...person, emailVerified: true, twoFactorEnabled: false, createdAt: new Date().toISOString() })
    const { instanceJar, landed } = await signInThroughRoot(root.url, origin, await throughRoot.signInAtRoot(person))
    if (landed.status !== 403) throw new Error(`root let ${email} into someone else's instance: ${landed.status} at ${landed.url}`)
    const held = instanceJar.get(SESSION_ID_COOKIE)
    thePage().cookieJar.setCookieSync(held ? `${SESSION_ID_COOKIE}=${held}; Path=/; HttpOnly; SameSite=Lax` : `${SESSION_ID_COOKIE}=; Path=/; HttpOnly; Expires=Thu, 01 Jan 1970 00:00:00 GMT`, `${origin}/`)
    return landed.text()
  }

  const signInAnother = async (email: string): Promise<SessionUser> => {
    if (root) throw new Error(`an instance signs in only its owner, and root turns ${email} away: use turnedAway`)
    const pending = await login({ email, password: PASSWORD, inviteCode: await invite() }, { register: true })
    if (!pending.verify) throw new Error(`signing up ${email} answered ${JSON.stringify(pending)}`)
    const made = await verifySignUp({ id: pending.verify, code: codeMailedTo(email) })
    if (!made.user) throw new Error(`confirming ${email} answered ${JSON.stringify(made)}`)
    return made.user
  }

  return { db, origin, rootUrl: root?.url ?? origin, mailbox, signIn, signInAnother, turnedAway, invite, codeMailedTo }
}
