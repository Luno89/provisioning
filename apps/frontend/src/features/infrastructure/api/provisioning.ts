import type { ProvisioningView } from '@koala/engine-core/koala-install'
import { api } from '../../../api/client'
import type { Permitted } from '../../platform'

export type { ProvisioningView }

export interface ProvisioningAnswer extends Permitted<'set-up-again'> {
  setups: ProvisioningView[]
  off?: string
}

export const provisioningKeys = {
  view: () => ['provisioning'] as const,
}

export const getProvisioning = (): Promise<ProvisioningAnswer> =>
  api.get<ProvisioningAnswer>('/infrastructure/provisioning').then((r) => r.data)

export const setUpAgain = (clusterId: string): Promise<ProvisioningView> =>
  api.post<ProvisioningView>('/infrastructure/provisioning/again', { clusterId }).then((r) => r.data)
