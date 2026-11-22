import { api, site, SITE_BASE } from '../../api/client'
import type { SessionPermissions } from './lib/permissions'

export type ConfirmWith = 'two-factor' | 'password' | 'email-code'

export interface SessionUser {
  id: string
  email: string
  permissions?: SessionPermissions
  confirmWith?: ConfirmWith
  hasPassword?: boolean
  twoFactorEnabled?: boolean
  twoFactorPhone?: string
  twoFactorPreferredMethod?: string
  emailVerified?: boolean
  createdAt?: string
  [key: string]: unknown
}

export const authKeys = {
  me: () => ['auth', 'me'] as const,
}

export const signedOut = (err: unknown): boolean => {
  const status = (err as { response?: { status?: number } }).response?.status
  return status === 401 || status === 403
}

export const getMe = (): Promise<SessionUser | null> =>
  api.get<SessionUser>('/auth/me').then((r) => r.data).catch((err: unknown) => {
    if (signedOut(err)) return null
    throw err
  })

export const logout = (): Promise<string | undefined> =>
  api.post<{ endSession?: string }>('/auth/logout', {}).then((r) => r.data.endSession)

export interface SignInAnswer {
  next?: string
  twoFactorRequired?: boolean
}

export interface SignUpAnswer {
  verify?: string
  devCode?: string
}

export interface SignUpCode {
  verify: string
  devCode?: string
}

export type InteractionPath = `/oidc/interaction/${string}`

export const register = (credentials: { email: string; password: string; inviteCode?: string }): Promise<SignUpAnswer> =>
  api.post<SignUpAnswer>('/auth/register', credentials).then((r) => r.data)

export const signIn = (resume: InteractionPath, credentials: { email: string; password: string }): Promise<SignInAnswer> =>
  site.post<SignInAnswer>(`${resume}/login`, credentials).then((r) => r.data)

export const confirmSecondFactor = (resume: InteractionPath, code: string): Promise<SignInAnswer> =>
  site.post<SignInAnswer>(`${resume}/second-factor`, { code }).then((r) => r.data)

export const verifySignUp = (resume: InteractionPath, body: { id: string; code: string }): Promise<SignInAnswer> =>
  site.post<SignInAnswer>(`${resume}/sign-up/verify`, body).then((r) => r.data)

export const resendSignUpCode = (id: string): Promise<SignUpCode> =>
  api.post<SignUpCode>('/auth/register/resend', { id }).then((r) => r.data)

export interface SignInProvider {
  id: string
  label: string
}

export interface SignInPlace {
  url: string
  providers?: SignInProvider[]
}

export const signInKeys = {
  place: () => ['auth', 'sign-in'] as const,
}

export const signInPlace = (): Promise<SignInPlace> =>
  api.get<SignInPlace>('/auth/sign-in').then((r) => r.data)

export const providerSignInUrl = (resume: InteractionPath, id: string, invite?: string): string =>
  `${SITE_BASE}${resume}/provider/${encodeURIComponent(id)}${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`

export const accountRemovalPlace = (): Promise<string | null> =>
  api.get<{ url: string | null }>('/auth/account-removal').then((r) => r.data.url)

