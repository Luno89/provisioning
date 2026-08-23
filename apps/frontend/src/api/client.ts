import axios from 'axios'

/**
 * The one HTTP client.
 *
 * ── WHAT THIS REPLACES ──
 * Every request in this app was `axios.get(\`${apiBase}/...\`)` written inline in a `queryFn`, with
 * `apiBase` threaded down as a prop through 44 files — the most pervasive prop in the codebase, for
 * a value that never changes after boot. There was no single place to change a path, add a header,
 * or find out who calls what.
 *
 * Credentials were handled three ways at once: `axios.defaults.withCredentials = true` set globally
 * in App.tsx, `{ withCredentials: true }` passed at 90 individual call sites, and
 * `credentials: 'include'` at 20 `fetch` sites. The global default is the worst of the three,
 * because it silently couples every component to App.tsx having been imported first — a component
 * rendered in a test without it would pass, and fail in production.
 *
 * One `axios.create` deletes all of that.
 *
 * ── THE RULE THIS EXISTS TO ENFORCE ──
 * No component contains a URL. Components import hooks; hooks call `api/<domain>.ts`; only those
 * modules touch this client. See the rulebook in CLAUDE.md.
 */

/**
 * Declared once, here.
 *
 * `API_BASE` and `SOCKET_URL` were each defined independently in three files (App.tsx,
 * TemporalPanel.tsx, ServicesPanel.tsx), so a change to either had to be made three times and would
 * work in two thirds of the app if it wasn't.
 */
export const API_BASE: string = import.meta.env.VITE_API_BASE || 'http://localhost:3001/api'
export const SOCKET_URL: string = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001'

export const api = axios.create({
  baseURL: API_BASE,
  // The session is a cookie, so every request needs this. Set once, where it cannot be forgotten.
  withCredentials: true,
})

/**
 * The message to show a user for a failed request.
 *
 * Promoted verbatim from `components/Lab/shared.ts`, where it was the only correct implementation
 * in the codebase and the only one that read the server's own `error` field instead of showing a
 * raw axios string. It reaches through `unknown` rather than taking `any`, which is why it survives
 * `strict`.
 */
export const errorMessage = (err: unknown): string => {
  const e = err as { response?: { data?: { error?: string } }; message?: string }
  return e?.response?.data?.error ?? e?.message ?? 'Something went wrong.'
}
