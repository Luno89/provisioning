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

export async function payloadRingOver(socket: AskingSocket): Promise<Keyring> {
  const answer = await askOver<{ ring?: Keyring; error?: string }>(socket, 'machine:payloads', {});
  if (!answer?.ring?.current) throw new Error(answer?.error ?? 'Koala sent no payload key');
  return answer.ring;
}

export const ringFingerprint = (ring: Keyring): string => [ring.current, ...(ring.previous ?? [])].map(keyId).join(',');


