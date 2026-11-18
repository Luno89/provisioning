import http from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import express, { type Router } from 'express'
import { afterAll } from 'vitest'
import { createAuth, type Auth } from '../../../../backend/src/platform/middleware/auth'
import { errorResponder } from '../../../../backend/src/platform/middleware/async-route'
import { SessionEnds } from '../../../../backend/src/platform/services/SessionEnds'
import { AccessRevocations } from '../../../../backend/src/platform/services/AccessRevocations'
import { TEST_DATA_KEY, testDatabase } from '../../../../backend/src/platform/lib/test-database'
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
import { login, verifySignUp, type SessionUser } from '../../features/platform'

export const SESSION_KEY = 'frontend-integration-session-key'
export const SETUP_CODE = 'frontend-integration-setup-code'
export const PASSWORD = 'a frontend integration password'

export interface Site {
  db: Database
  api: Router
  auth: Auth
  origin: string
}

export interface Mail {
  to: string
  subject: string
  text: string
}

export interface Backend {
  db: Database
  origin: string
  mailbox: Mail[]
  signIn: (email?: string) => Promise<SessionUser>
  signInAnother: (email: string) => Promise<SessionUser>
  invite: () => Promise<string>
  codeMailedTo: (email: string) => string
}

interface Page {
  reconfigure: (settings: { url: string }) => void
  window: { _origin: string }
}

const moveThePageTo = (origin: string): void => {
  const dom = (globalThis as { jsdom?: Page }).jsdom
  if (!dom) throw new Error('the frontend integration tier runs in jsdom, whose page has to move to the backend it talks to')
  dom.reconfigure({ url: `${origin}/` })
  dom.window._origin = origin
}

export async function startBackend(mount: (site: Site) => void | Promise<void>): Promise<Backend> {
  const db = await testDatabase()
  await seedAll(db)
  const app = express()
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const sessionEnds = new SessionEnds(db.platform)
  const revocations = new AccessRevocations()
  const auth = createAuth({ db, sessionKey: SESSION_KEY, publicUrl: origin, role: 'root', setupCode: SETUP_CODE, sessionEnds })
  const mailbox: Mail[] = []
  const authService = new AuthService(db, { mail: { available: () => ({ ok: true }), toAddress: async (to, message) => { mailbox.push({ to, ...message }) } } })
  const passwords = new PasswordService({ db, auth: authService, breached: loadBreachedPasswords(), revocations })
  const devices = devicesFor({ auth, sessionKey: SESSION_KEY, authService })

  app.use('/api', auth.requireAuth)
  app.use(express.json({ limit: JSON_LIMITS.signedIn }))
  app.use('/api/auth', authRouter({ db, authService, auth, sessionKey: SESSION_KEY, appUrl: origin, revocations, passwords }))
  app.use('/api/auth/password', passwordRouter({ passwords, auth, devices, sessionKey: SESSION_KEY }))
  const api = express.Router()
  app.use('/api', api)
  await mount({ db, api, auth, origin })
  app.use(errorResponder)

  moveThePageTo(origin)

  const signIn = async (email = 'owner@koala.test'): Promise<SessionUser> => {
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

  const signInAnother = async (email: string): Promise<SessionUser> => {
    const pending = await login({ email, password: PASSWORD, inviteCode: await invite() }, { register: true })
    if (!pending.verify) throw new Error(`signing up ${email} answered ${JSON.stringify(pending)}`)
    const made = await verifySignUp({ id: pending.verify, code: codeMailedTo(email) })
    if (!made.user) throw new Error(`confirming ${email} answered ${JSON.stringify(made)}`)
    return made.user
  }

  return { db, origin, mailbox, signIn, signInAnother, invite, codeMailedTo }
}
