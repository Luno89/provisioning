import { api } from '../../../api/client'

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
  api.get<InstanceAddressesView | null>('/instance-addresses').then((r) => r.data)

export const setNestedAddresses = (nested: boolean): Promise<InstanceAddressesView> =>
  api.put<InstanceAddressesView>('/instance-addresses', { nested }).then((r) => r.data)
