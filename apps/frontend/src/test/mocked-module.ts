import { vi } from 'vitest'

export const withMocked = async <T extends object>(importOriginal: () => Promise<T>, ...names: Array<keyof T & string>): Promise<T> => ({
  ...(await importOriginal()),
  ...Object.fromEntries(names.map((name) => [name, vi.fn()])),
})

export const withResolved = async <T extends object>(importOriginal: () => Promise<T>, answers: Partial<Record<keyof T & string, unknown>>): Promise<T> => ({
  ...(await importOriginal()),
  ...Object.fromEntries(Object.entries(answers).map(([name, answer]) => [name, vi.fn().mockResolvedValue(answer)])),
})
