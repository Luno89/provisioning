import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  buyServer, cancelServerOrder, FOLLOWED, getServerOrder, listServerOrders, quoteServer, serverOrderKeys,
  type QuoteAsk, type ServerOrder,
} from '../api/server-orders'

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
