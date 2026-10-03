import axios from 'axios'

export interface BackendAddress {
  apiBase: string
  socketUrl: string
  origin: string
}

export function backendAddress(given: { apiBase?: string | undefined; socketUrl?: string | undefined; dev: boolean; pageOrigin: string }): BackendAddress {
  const apiBase = given.apiBase || (given.dev ? 'http://localhost:3001/api' : '/api')
  const origin = new URL(apiBase, given.pageOrigin).origin
  return { apiBase, origin, socketUrl: given.socketUrl || origin }
}

const address = backendAddress({
  apiBase: import.meta.env.VITE_API_BASE,
  socketUrl: import.meta.env.VITE_SOCKET_URL,
  dev: import.meta.env.DEV,
  pageOrigin: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
})

export const API_BASE: string = address.apiBase
export const SOCKET_URL: string = address.socketUrl
export const BACKEND_ORIGIN: string = address.origin

export const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true,
})

export const serverError = (err: unknown): string | undefined =>
  (err as { response?: { data?: { error?: string } } } | undefined)?.response?.data?.error

export const errorMessage = (err: unknown): string =>
  serverError(err) ?? (err as { message?: string } | undefined)?.message ?? 'Something went wrong.'

