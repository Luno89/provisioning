import { api } from '../../api/client'
import type { SessionPermissions } from './lib/permissions'

export interface SessionUser {
  id: string
  email: string
  permissions?: SessionPermissions
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

export const signInElsewhere = (): Promise<string | null> =>
  api.get<{ url: string | null }>('/auth/sign-in').then((r) => r.data.url).catch(() => null)

export const accountRemovalPlace = (): Promise<string | null> =>
  api.get<{ url: string | null }>('/auth/account-removal').then((r) => r.data.url)

