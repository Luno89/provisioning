import { isAxiosError } from 'axios'
import { api } from './client'

export interface InstanceAddressesView {
  nested: boolean
  state?: 'issuing' | 'ready'
  detail?: string
  name: string
  domain: string
}

export const instanceAddressKeys = {
  mine: () => ['instance-addresses'] as const,
}

export const getInstanceAddresses = (): Promise<InstanceAddressesView | null> =>
  api.get<InstanceAddressesView>('/instance-addresses').then((r) => r.data).catch((err: unknown) => {
    if (isAxiosError(err) && err.response?.status === 404) return null
    throw err
  })

export const setNestedAddresses = (nested: boolean): Promise<InstanceAddressesView> =>
  api.put<InstanceAddressesView>('/instance-addresses', { nested }).then((r) => r.data)
