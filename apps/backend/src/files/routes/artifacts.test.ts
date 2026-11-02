import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { dispatch, SIGNED_IN } from '../../releases/testing/dispatch.js';
import { contentTypeOf, type StoredArtifact } from '../lib/artifacts.js';
import { artifactsRouter, type ArtifactsRouterDeps } from './artifacts.js';

const artifact = (name: string, contentType = contentTypeOf(name)): StoredArtifact => ({ id: name, ownerId: SIGNED_IN.id, runId: 'run-1', name, contentType, size: 3, place: 'mongo', createdAt: 't', expiresAt: 't2' });

function setUp() {
  const artifacts = mock<ArtifactsRouterDeps['artifacts']>();
  const deps = mock<ArtifactsRouterDeps>({ artifacts });
  return { artifacts, hasMinio: deps.hasMinio, router: artifactsRouter(deps) };
}

describe('/api/artifacts', () => {
  it('serves a screenshot inline as what it is', async () => {
    const { artifacts, router } = setUp();
    artifacts.get.calledWith(SIGNED_IN.id, 'shot').mockResolvedValue({ artifact: artifact('signs-in/test-failed-1.png'), bytes: Buffer.from('png-bytes') });
    const res = await dispatch(router, { method: 'GET', url: '/shot' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toBe("inline; filename*=UTF-8''test-failed-1.png");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-length']).toBe('9');
    expect(res.text).toBe('png-bytes');
  });

  it('downloads a trace rather than opening it', async () => {
    const { artifacts, router } = setUp();
    artifacts.get.mockResolvedValue({ artifact: artifact('signs-in/trace.zip'), bytes: Buffer.from('zip') });
    const res = await dispatch(router, { method: 'GET', url: '/trace' });
    expect(res.headers['content-disposition']).toBe("attachment; filename*=UTF-8''trace.zip");
  });

  it('never opens a file it has no safe type for, and lets it run none', async () => {
    const { artifacts, router } = setUp();
    artifacts.get.mockResolvedValue({ artifact: artifact('signs-in/drawn.svg'), bytes: Buffer.from('<svg/>') });
    const res = await dispatch(router, { method: 'GET', url: '/drawn' });
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe("attachment; filename*=UTF-8''drawn.svg");
    expect(res.headers['content-security-policy']).toMatch(/sandbox$/);
  });

  it('says so for an artifact the person does not have', async () => {
    const { artifacts, router } = setUp();
    artifacts.get.mockResolvedValue(undefined);
    const res = await dispatch(router, { method: 'GET', url: '/theirs' });
    expect([res.status, res.json]).toEqual([404, { error: 'You have no artifact with that id' }]);
  });

  it('lists a run\'s artifacts and says whether the person has MinIO', async () => {
    const { artifacts, hasMinio, router } = setUp();
    const listed = [artifact('a.png')];
    artifacts.list.calledWith(SIGNED_IN.id, 'run-1').mockResolvedValue(listed);
    hasMinio.calledWith(SIGNED_IN.id).mockResolvedValue(true);
    expect((await dispatch(router, { method: 'GET', url: '/runs/run-1' })).json).toEqual({ artifacts: listed });
    expect((await dispatch(router, { method: 'GET', url: '/storage' })).json).toEqual({ minio: true });
  });
});
