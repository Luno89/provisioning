import axios from 'axios'

export const API_BASE: string = import.meta.env.VITE_API_BASE || 'http://localhost:3001/api'
export const SOCKET_URL: string = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001'

export const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true,
})

export const errorMessage = (err: unknown): string => {
  const e = err as { response?: { data?: { error?: string } }; message?: string }
  return e?.response?.data?.error ?? e?.message ?? 'Something went wrong.'
}

export type StreamResponse = Response & { body: ReadableStream<Uint8Array> }

export async function postStream(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<StreamResponse> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  })
  if (!res.ok || !res.body) {
    const detail = await res.json().catch(() => ({} as { error?: string }))
    throw new Error(detail.error || `Request failed (HTTP ${res.status})`)
  }
  return res as StreamResponse
}
