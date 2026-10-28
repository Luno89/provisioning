export interface EndpointSlices {
  items?: {
    endpoints?: {
      addresses?: string[];
      conditions?: { ready?: boolean | null; terminating?: boolean | null };
    }[] | null;
  }[];
}

type Endpoint = NonNullable<NonNullable<NonNullable<EndpointSlices['items']>[number]['endpoints']>[number]>;

const listsPod = (endpoint: Endpoint, podIp: string) => (endpoint.addresses ?? []).includes(podIp);
const ready = (endpoint: Endpoint) => endpoint.conditions?.ready !== false;
const comingUp = (endpoint: Endpoint) => !ready(endpoint) && endpoint.conditions?.terminating !== true;

export function stillRoutedTo(slices: EndpointSlices, podIp: string): boolean {
  return (slices.items ?? []).some((slice) => {
    const endpoints = slice.endpoints ?? [];
    const own = endpoints.filter((endpoint) => listsPod(endpoint, podIp));
    if (own.length === 0) return false;
    if (own.some(ready)) return true;
    const others = endpoints.filter((endpoint) => !listsPod(endpoint, podIp));
    return !others.some(ready) && others.some(comingUp);
  });
}

export interface PodPlace {
  ip: string;
  namespace: string;
}

export function podPlaceFrom(env: Readonly<Record<string, string | undefined>>): PodPlace | undefined {
  const ip = env.POD_IP?.trim();
  const namespace = env.POD_NAMESPACE?.trim();
  return ip && namespace ? { ip, namespace } : undefined;
}
