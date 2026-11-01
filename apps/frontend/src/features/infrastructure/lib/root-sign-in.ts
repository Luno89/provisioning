import type { SignInAsk } from '../api/server-orders'

export type SignInValues = Readonly<Record<string, Readonly<Record<string, string>>>>

export function signInAsks(values: SignInValues): SignInAsk[] {
  return Object.entries(values).flatMap(([id, fields]) => {
    const given = Object.fromEntries(Object.entries(fields).map(([key, value]): [string, string] => [key, value.trim()]).filter(([, value]) => value))
    return Object.keys(given).length ? [{ id, values: given }] : []
  })
}

export function withValue(values: SignInValues, id: string, key: string, value: string): SignInValues {
  return { ...values, [id]: { ...(values[id] ?? {}), [key]: value } }
}
