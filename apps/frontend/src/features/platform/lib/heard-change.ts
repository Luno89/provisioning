import type { QueryClient, QueryFilters } from '@tanstack/react-query'

export async function heardChange(client: QueryClient, filters: QueryFilters = {}): Promise<void> {
  await client.cancelQueries(filters)
  await client.invalidateQueries(filters)
}
