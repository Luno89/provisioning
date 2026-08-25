import { api } from './client'

/**
 * Session, and the two calls the shell makes on boot and on logout.
 *
 * ── WHY `me` SWALLOWS ITS ERROR ──
 * A 401 here is the ORDINARY state: nobody is signed in yet, and the shell renders the login
 * screen. Letting it reject would make "not signed in" indistinguishable from "the backend is
 * down", and App would show an error where it should show a form. It resolves `null` instead.
 *
 * Everything else in this layer does the opposite and throws, because everywhere else a 401 means
 * a session expired mid-use, which the user does need to be told about.
 */

/**
 * The signed-in user, as `/auth/me` returns it.
 *
 * Declared here rather than in `stores/shell.ts` because it is a WIRE shape: the store holds it,
 * but the route decides what is in it. `shell.ts` imports this as its `AppUser` so there is one
 * answer — it previously had its own copy, which is how a field the endpoint returns can end up
 * unknown to the screen reading it.
 *
 * The index signature is deliberate: `/auth/me` returns more than any screen currently reads, and
 * narrowing it field by field as screens start using them beats guessing the whole record now.
 */
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

/** The signed-in user, or null when nobody is. */
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

/**
 * Password sign-in — or registration when `register` is set.
 *
 * Unlike `getMe`, a failure here THROWS: the caller is mid-interaction, and "wrong password" is
 * information the user needs. The backend's `{ error }` body is re-thrown as its message so the
 * form can show exactly what the server said.
 */
export const login = (
  credentials: { email: string; password: string; inviteCode?: string },
  opts: { register?: boolean } = {},
): Promise<LoginResult> =>
  api
    .post<LoginResult>(opts.register ? '/auth/register' : '/auth/login', credentials)
    .then((r) => r.data)

/** Second step of an enforced-2FA sign-in. Same throw-on-error contract as `login`. */
export const verifyTwoFactor = (body: { userId: string; code: string }): Promise<LoginResult> =>
  api.post<LoginResult>('/auth/2fa/verify', body).then((r) => r.data)

