import { deleteApp, getApps } from './api';

declare function useQuery(options: { queryFn: () => Promise<unknown> }): unknown;

export function useApps(): unknown {
  return useQuery({ queryFn: getApps });
}

export function useDelete(id: string): Promise<string> {
  return deleteApp(id);
}
