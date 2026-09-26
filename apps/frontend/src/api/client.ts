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

