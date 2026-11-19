import { blobToWire, keyId, type BlobReach, type Keyring } from '@koala/engine-core/payloads';

export interface AskingSocket {
  readonly connected: boolean;
  emit(event: string, payload: unknown, ack: (answer: never) => void): unknown;
  once(event: 'disconnect', listener: () => void): unknown;
  off(event: 'disconnect', listener: () => void): unknown;
}

export function askOver<T>(socket: AskingSocket, event: string, payload: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!socket.connected) return reject(new Error('this machine is not connected to Koala right now'));
    const gone = () => reject(new Error(`this machine lost its connection to Koala before ${event} was answered`));
    socket.once('disconnect', gone);
    socket.emit(event, payload, (answer: never) => {
      socket.off('disconnect', gone);
      resolve(answer as T);
    });
  });
}

export function remoteBlobs(socket: AskingSocket): BlobReach {
  return {
    async put(blobs) {
      const answer = await askOver<{ ok: boolean; error?: string }>(socket, 'payloads:put', { blobs: blobs.map(blobToWire) });
      if (!answer?.ok) throw new Error(answer?.error ?? 'Koala did not store the payloads');
    },
    async get(ids) {
      const answer = await askOver<{ found?: Record<string, string>; error?: string }>(socket, 'payloads:get', { ids });
      if (!answer?.found) throw new Error(answer?.error ?? 'Koala did not send the payloads');
      return new Map(Object.entries(answer.found).map(([id, data]) => [id, Buffer.from(data, 'base64')]));
    },
  };
}

export interface MachineTemporal {
  address: string;
  namespace: string;
  ca: string;
  serverName: string;
}

export interface EngineSettings {
  ring: Keyring;
  temporal?: MachineTemporal | undefined;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

export async function engineSettingsOver(socket: AskingSocket): Promise<EngineSettings> {
  const answer = await askOver<{ ring?: Keyring; temporal?: { address?: unknown; namespace?: unknown; ca?: unknown; serverName?: unknown }; error?: string }>(socket, 'machine:payloads', {});
  if (!answer?.ring?.current) throw new Error(answer?.error ?? 'Koala sent no payload key');
  const address = text(answer.temporal?.address);
  const namespace = text(answer.temporal?.namespace);
  if (!address || !namespace) return { ring: answer.ring };
  const ca = text(answer.temporal?.ca);
  const serverName = text(answer.temporal?.serverName);
  if (!ca || !serverName) throw new Error(`Koala named its Temporal at ${address} without the certificate authority and name to check it by, and a machine reaches Temporal only over TLS, so this machine takes no work until its Koala is updated`);
  return { ring: answer.ring, temporal: { address, namespace, ca, serverName } };
}

export const ringFingerprint = (ring: Keyring): string => [ring.current, ...(ring.previous ?? [])].map(keyId).join(',');

export const settingsFingerprint = (settings: EngineSettings): string =>
  `${ringFingerprint(settings.ring)}|${settings.temporal ? `${settings.temporal.address}/${settings.temporal.namespace}/${settings.temporal.serverName}/${keyId(settings.temporal.ca)}` : ''}`;


