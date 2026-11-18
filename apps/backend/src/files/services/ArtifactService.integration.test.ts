import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realStoredFiles, type RealStoredFiles } from '../testing/real-stored-files.js';
import { ArtifactService } from './ArtifactService.js';

let real: RealStoredFiles;
beforeAll(async () => { real = await realStoredFiles(); });
afterAll(async () => { await real?.stop(); });

const bytesOf = async (body: NodeJS.ReadableStream): Promise<Buffer> => {
  const parts: Buffer[] = [];
  for await (const part of body) parts.push(Buffer.from(part as Buffer));
  return Buffer.concat(parts);
};

describe('keeping a run\'s artifacts on the instance\'s MinIO, through Temporal', () => {
  it('keeps each file whole, reads it back by its id, and removes it with its run', async () => {
    const artifacts = new ArtifactService({ files: real.files });
    const report = Buffer.from('<html>passed</html>');
    const kept = await artifacts.put('bo', 'run-1', [{ name: 'report.html', bytes: report, contentType: 'text/html' }]);
    expect(kept.dropped).toEqual([]);
    expect(kept.stored[0]).toMatchObject({ name: 'report.html', contentType: 'text/html', size: report.length, runId: 'run-1' });
    expect(await real.objects.stat(kept.stored[0]!.id)).toEqual({ size: report.length });
    const read = await artifacts.get('bo', kept.stored[0]!.id);
    expect(await bytesOf(read!.body)).toEqual(report);
    expect(await artifacts.removeRun('bo', 'run-1')).toBe(1);
    expect(await real.objects.stat(kept.stored[0]!.id)).toBeUndefined();
    expect(await real.db.files.storedFileById(kept.stored[0]!.id)).toBeUndefined();
  });
});
