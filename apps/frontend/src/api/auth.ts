import { api } from './client'

export interface SessionUser {
  id: string
  email: string
  isAdmin?: boolean
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

export const getMe = (): Promise<SessionUser | null> =>
  api.get<SessionUser>('/auth/me').then((r) => r.data).catch(() => null)

export const logout = (): Promise<void> =>
  api.post('/auth/logout', {}).then(() => undefined)

export interface LoginResult {
  user?: SessionUser
  twoFactorRequired?: boolean
  userId?: string
  error?: string
}

export const login = (
  credentials: { email: string; password: string; inviteCode?: string },
  opts: { register?: boolean } = {},
): Promise<LoginResult> =>
  api
    .post<LoginResult>(opts.register ? '/auth/register' : '/auth/login', credentials)
    .then((r) => r.data)

export const verifyTwoFactor = (body: { userId: string; code: string }): Promise<LoginResult> =>
  api.post<LoginResult>('/auth/2fa/verify', body).then((r) => r.data)

export const signInElsewhere = (): Promise<string | null> =>
  api.get<{ url: string | null }>('/auth/sign-in').then((r) => r.data.url).catch(() => null)

export const exchangeHandoff = (token: string): Promise<SessionUser> =>
  api.post<{ user: SessionUser }>('/auth/handoff', { token }).then((r) => r.data.user)
