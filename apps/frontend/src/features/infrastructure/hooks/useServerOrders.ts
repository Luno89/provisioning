import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  buyServer, cancelServerOrder, checkZones, FOLLOWED, getServerOrder, listRootSignInProviders, listServerOrders, quoteServer, serverOrderKeys,
  type QuoteAsk, type ServerOrder,
} from '../api/server-orders'
import { credentialKeys, listDnsProviders } from '../api/credentials'

export const SERVER_ORDER_POLL_MS = 3_000

export function useServerOrders() {
  return useQuery({ queryKey: serverOrderKeys.all, queryFn: listServerOrders, refetchInterval: SERVER_ORDER_POLL_MS })
}

export function useServerOrder(id: string | undefined) {
  return useQuery({
    queryKey: serverOrderKeys.one(id ?? ''),
    queryFn: () => getServerOrder(id!),
    enabled: Boolean(id),
    refetchInterval: (query) => (query.state.data && FOLLOWED.includes(query.state.data.state) ? SERVER_ORDER_POLL_MS : false),
  })
}

function useOrderChange<A>(run: (arg: A) => Promise<ServerOrder>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: run,
    onSuccess: (order) => {
      client.setQueryData(serverOrderKeys.one(order.id), order)
      void client.invalidateQueries({ queryKey: serverOrderKeys.all })
    },
  })
}

export const useQuoteServer = () => useOrderChange((ask: QuoteAsk) => quoteServer(ask))
export const useBuyServer = () => useOrderChange(({ id, total }: { id: string; total: number }) => buyServer(id, total))
export const useCancelServerOrder = () => useOrderChange((id: string) => cancelServerOrder(id))

export function useZoneChecks(zones: readonly string[]) {
  const named = zones.map((zone) => zone.trim().toLowerCase()).filter((zone) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(zone))
  return useQuery({ queryKey: serverOrderKeys.zones(named), queryFn: () => checkZones(named), enabled: named.length > 0 })
}

export function useDnsProviders() {
  return useQuery({ queryKey: credentialKeys.dns(), queryFn: listDnsProviders, staleTime: Infinity })
}

export function useRootSignInProviders(domain: string) {
  const named = domain.trim().toLowerCase()
  return useQuery({ queryKey: serverOrderKeys.signIn(named), queryFn: () => listRootSignInProviders(named), placeholderData: (previous) => previous, staleTime: Infinity })
}
