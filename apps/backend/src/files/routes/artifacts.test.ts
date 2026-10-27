import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { artifactsRouter } from './artifacts.js';
import { ArtifactService } from '../services/ArtifactService.js';
import type { StoredArtifact } from '../lib/artifacts.js';

const get = (url: string) => axios.get(url, { validateStatus: () => true, responseType: 'arraybuffer' });

describe('/api/artifacts', () => {
  let harness: Harness;
  let stored: StoredArtifact[];
  const named = (name: string) => stored.find((artifact) => artifact.name.endsWith(name))!;

  beforeEach(async () => {
    harness = await mountRouter({
      prefix: '/api/artifacts',
      router: async (db) => {
        const artifacts = new ArtifactService({ records: db.files, minioFor: async () => undefined });
        stored = (await artifacts.put(TEST_USER.id, 'run-1', [
          { name: 'signs-in/test-failed-1.png', bytes: Buffer.from('png-bytes') },
          { name: 'signs-in/trace.zip', bytes: Buffer.from('zip') },
          { name: 'signs-in/drawn.svg', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') },
        ])).stored;
        await artifacts.put('someone-else', 'run-2', [{ name: 'theirs.png', bytes: Buffer.from('x') }]);
        return artifactsRouter({ artifacts, hasMinio: async () => false });
      },
    });
  });

  afterEach(() => harness.close());

  it('serves a screenshot inline as what it is', async () => {
    const res = await get(harness.url(`/api/artifacts/${named('test-failed-1.png').id}`));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toBe("inline; filename*=UTF-8''test-failed-1.png");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(res.data).toString()).toBe('png-bytes');
  });

  it('downloads a trace rather than opening it', async () => {
    const res = await get(harness.url(`/api/artifacts/${named('trace.zip').id}`));
    expect(res.headers['content-disposition']).toBe("attachment; filename*=UTF-8''trace.zip");
  });

  it('never opens a file it has no safe type for, and lets it run none', async () => {
    const res = await get(harness.url(`/api/artifacts/${named('drawn.svg').id}`));
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe("attachment; filename*=UTF-8''drawn.svg");
    expect(res.headers['content-security-policy']).toMatch(/sandbox$/);
  });

  it('lists a run\'s artifacts and says whether the person has MinIO', async () => {
    const listed = await axios.get(harness.url('/api/artifacts/runs/run-1'));
    expect(listed.data.artifacts.map((a: StoredArtifact) => a.name).sort()).toEqual(['signs-in/drawn.svg', 'signs-in/test-failed-1.png', 'signs-in/trace.zip']);
    expect((await axios.get(harness.url('/api/artifacts/storage'))).data).toEqual({ minio: false });
  });

  it('never serves or lists someone else\'s', async () => {
    const theirs = (await harness.db.files.getArtifacts('someone-else'))[0]!;
    expect((await get(harness.url(`/api/artifacts/${theirs.id}`))).status).toBe(404);
    expect((await axios.get(harness.url('/api/artifacts/runs/run-2'))).data.artifacts).toEqual([]);
  });
});
