import { vi, type Mock } from 'vitest'
import type * as Client from '../api/client'

type Verb = 'get' | 'post' | 'delete'

export const mockedApi = async (importOriginal: <T>() => Promise<T>, ...verbs: Verb[]): Promise<Omit<typeof Client, 'api'> & { api: Partial<Record<Verb, Mock>> }> => {
  const original = await importOriginal<typeof Client>()
  return { ...original, api: Object.fromEntries(verbs.map((verb) => [verb, vi.fn()])) }
}
