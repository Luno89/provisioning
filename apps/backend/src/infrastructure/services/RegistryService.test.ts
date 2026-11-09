import { matching } from '../../platform/lib/test-matchers.js';
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mockFn } from 'vitest-mock-extended';
import { interceptHttp } from '../../platform/testing/http.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { Shell } from '../lib/shell.js';
import { RegistryService } from './RegistryService.js';

const server = interceptHttp();
const service = (shell: Shell = mockFn<Shell>()) => new RegistryService(memoryDatabase(), shell);
const hubTags = (names: string[], next: string | null = null) => HttpResponse.json({ results: names.map((name) => ({ name })), next });

describe('RegistryService.search', () => {
  it('searches Docker Hub and returns the repositories it found', async () => {
    server.use(http.get('https://hub.docker.com/v2/search/repositories/', ({ request }) => (new URL(request.url).searchParams.get('query') === 'nginx' ? HttpResponse.json({ results: [{ repo_name: 'nginx' }] }) : HttpResponse.json({ results: [] }))));
    expect(await service().search('nginx')).toEqual([{ repo_name: 'nginx' }]);
  });
});

describe('RegistryService.getTags', () => {
  it('answers latest for no repository, without asking anyone', async () => {
    expect(await service().getTags('')).toEqual(['latest']);
  });

  it('reads an official image\'s tags from Docker Hub, following its pages, newest first', async () => {
    server.use(
      http.get('https://hub.docker.com/v2/repositories/library/nginx/tags', ({ request }) => (new URL(request.url).searchParams.get('page') === '2' ? hubTags(['1.25']) : hubTags(['1.27', '1.26'], 'https://hub.docker.com/v2/repositories/library/nginx/tags?page=2'))),
    );
    expect(await service().getTags('nginx')).toEqual(['1.27', '1.26', '1.25']);
  });

  it('asks again only after its answer has expired', async () => {
    let asked = 0;
    server.use(http.get('https://hub.docker.com/v2/repositories/library/redis/tags', () => { asked += 1; return hubTags(['7']); }));
    const registry = service();
    await registry.getTags('redis');
    await registry.getTags('redis');
    expect(asked).toBe(1);
  });

  it('reads a Bitnami image\'s tags from the public ECR gallery', async () => {
    server.use(http.get('https://api.gallery.ecr.aws/v1/repository/public/tags', ({ request }) => (new URL(request.url).searchParams.get('repositoryName') === 'odoo' ? HttpResponse.json({ tags: [{ tagName: '18.0.1' }, { tagName: '17.0.2' }] }) : HttpResponse.json({ tags: [] }))));
    expect(await service().getTags('bitnami/odoo')).toEqual(expect.arrayContaining(['18.0.1', '17.0.2']));
  });

  it('reads a GitHub Container Registry image\'s tags with a pull token', async () => {
    server.use(
      http.get('https://ghcr.io/token', () => HttpResponse.json({ token: 'pull-token' })),
      http.get('https://ghcr.io/v2/advplyr/audiobookshelf/tags/list', ({ request }) => (request.headers.get('authorization') === 'Bearer pull-token' ? HttpResponse.json({ tags: ['2.1.0', '2.2.0'] }) : new HttpResponse(null, { status: 401 }))),
    );
    expect(await service().getTags('ghcr.io/advplyr/audiobookshelf')).toEqual(expect.arrayContaining(['2.1.0', '2.2.0']));
  });

  it('says why, rather than offering tags it never read, when the registry cannot be asked', async () => {
    server.use(http.get('https://hub.docker.com/v2/repositories/jellyfin/jellyfin/tags', () => new HttpResponse(null, { status: 500 })));
    await expect(service().getTags('jellyfin/jellyfin')).rejects.toMatchObject({ status: 502, message: 'The tags of jellyfin/jellyfin could not be read from Docker Hub: it answered 500' });
    server.use(
      http.get('https://ghcr.io/token', () => HttpResponse.json({ token: 'pull-token' })),
      http.get('https://ghcr.io/v2/theroyallab/tabbyapi/tags/list', () => HttpResponse.error()),
    );
    await expect(service().getTags('ghcr.io/theroyallab/tabbyapi')).rejects.toMatchObject({ status: 502, message: matching(/^The tags of ghcr\.io\/theroyallab\/tabbyapi could not be read from the GitHub Container Registry: /) });
  });

  it('finds no tags for an image the registry has none for, and keeps no answer it could not read', async () => {
    server.use(http.get('https://hub.docker.com/v2/repositories/someone/unknown/tags', () => hubTags([])));
    expect(await service().getTags('someone/unknown')).toEqual([]);
    let failing = true;
    server.use(http.get('https://hub.docker.com/v2/repositories/someone/flaky/tags', () => (failing ? new HttpResponse(null, { status: 503 }) : hubTags(['1.0']))));
    const registry = service();
    await expect(registry.getTags('someone/flaky')).rejects.toMatchObject({ status: 502 });
    failing = false;
    expect(await registry.getTags('someone/flaky')).toEqual(['1.0']);
  });

  it('pages the tags it found', async () => {
    server.use(http.get('https://hub.docker.com/v2/repositories/library/nginx/tags', () => hubTags(['1.27', '1.26', '1.25'])));
    expect(await service().getTagPage('nginx', { page: 1, pageSize: 2, sort: 'newest' })).toMatchObject({ page: 1, pageSize: 2, total: 3, totalPages: 2 });
  });
});

describe('RegistryService.getLocalTags', () => {
  it('lists the tags Docker has for an image, once each, without the untagged', async () => {
    const shell = mockFn<Shell>();
    shell.calledWith('docker images --format "{{.Tag}}" "nginx"').mockResolvedValue({ stdout: '1.27\n1.27\n<none>\n \nlatest\n', stderr: '' });
    expect(await service(shell).getLocalTags('nginx')).toEqual(['1.27', 'latest']);
  });

  it('escapes what could break out of the quoted name', async () => {
    const shell = mockFn<Shell>();
    shell.mockResolvedValue({ stdout: '', stderr: '' });
    await service(shell).getLocalTags('a"; rm -rf /; "');
    expect(shell).toHaveBeenCalledWith('docker images --format "{{.Tag}}" "a\\"; rm -rf /; \\""');
  });

  it('lists none when Docker cannot be asked', async () => {
    const shell = mockFn<Shell>();
    shell.mockRejectedValue(new Error('docker: not found'));
    expect(await service(shell).getLocalTags('nginx')).toEqual([]);
  });
});
