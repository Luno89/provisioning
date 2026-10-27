export interface EndpointSlices {
  items?: {
    endpoints?: {
      addresses?: string[];
      conditions?: { ready?: boolean | null };
    }[] | null;
  }[];
}

export function stillRoutedTo(slices: EndpointSlices, podIp: string): boolean {
  return (slices.items ?? []).some((slice) => (slice.endpoints ?? []).some((endpoint) =>
    (endpoint.addresses ?? []).includes(podIp) && endpoint.conditions?.ready !== false));
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
