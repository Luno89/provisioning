import { api, API_BASE } from '../../api/client'
import type { SessionPermissions } from './lib/permissions'

export type ConfirmWith = 'two-factor' | 'password' | 'email-code'

export interface SessionUser {
  id: string
  email: string
  permissions?: SessionPermissions
  confirmWith?: ConfirmWith
  hasPassword?: boolean
  onHub?: boolean
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

export const logout = (): Promise<void> =>
  api.post('/auth/logout', {}).then(() => undefined)

export interface LoginResult {
  user?: SessionUser
  twoFactorRequired?: boolean
  challenge?: string
  verify?: string
  devCode?: string
  error?: string
}

export interface SignUpCode {
  verify: string
  devCode?: string
}

export const login = (
  credentials: { email: string; password: string; inviteCode?: string },
  opts: { register?: boolean } = {},
): Promise<LoginResult> =>
  api
    .post<LoginResult>(opts.register ? '/auth/register' : '/auth/login', credentials)
    .then((r) => r.data)

export const verifySignUp = (body: { id: string; code: string }): Promise<LoginResult> =>
  api.post<LoginResult>('/auth/register/verify', body).then((r) => r.data)

export const resendSignUpCode = (id: string): Promise<SignUpCode> =>
  api.post<SignUpCode>('/auth/register/resend', { id }).then((r) => r.data)

export const verifyTwoFactor = (body: { challenge: string; code: string }): Promise<LoginResult> =>
  api.post<LoginResult>('/auth/2fa/verify', body).then((r) => r.data)

export interface SignInProvider {
  id: string
  label: string
}

export interface SignInPlace {
  url: string | null
  providers: SignInProvider[]
}

export const signInKeys = {
  place: () => ['auth', 'sign-in'] as const,
}

export const signInPlace = (): Promise<SignInPlace> =>
  api.get<{ url?: string | null; providers?: SignInProvider[] }>('/auth/sign-in')
    .then((r) => ({ url: r.data.url ?? null, providers: r.data.providers ?? [] }))
    .catch(() => ({ url: null, providers: [] }))

export const providerSignInUrl = (id: string, invite?: string): string =>
  `${API_BASE.replace(/\/api$/, '')}/api/auth/provider/${encodeURIComponent(id)}${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`

export const accountRemovalPlace = (): Promise<string | null> =>
  api.get<{ url: string | null }>('/auth/account-removal').then((r) => r.data.url)

