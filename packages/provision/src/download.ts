import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';

export interface Download {
  what: string;
  url: string;
  to: string;
  sha256: string;
  fetcher?: typeof fetch;
}

const reasonOf = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
  return cause ? `${message} (${cause})` : message;
};

export async function downloadChecked(download: Download): Promise<void> {
  const { what, url, to } = download;
  let response: Response;
  try {
    response = await (download.fetcher ?? fetch)(url);
  } catch (err) {
    throw new Error(`${what} could not be downloaded from ${url}: ${reasonOf(err)}`, { cause: err });
  }
  if (!response.ok || !response.body) throw new Error(`${what} could not be downloaded: ${url} answered ${response.status}`);
  const hash = createHash('sha256');
  await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), async function* (source: AsyncIterable<Buffer>) {
    for await (const chunk of source) {
      hash.update(chunk);
      yield chunk;
    }
  }, createWriteStream(to, { mode: 0o600 }));
  if (hash.digest('hex') !== download.sha256) {
    await rm(to, { force: true });
    throw new Error(`${what} from ${url} is not the one Koala pins (its sha256 differs); nothing was installed`);
  }
}
