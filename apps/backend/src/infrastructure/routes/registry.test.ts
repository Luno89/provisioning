import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { TagPageRequest } from '../lib/registry-tags.js';
import type { RegistryService } from '../services/RegistryService.js';
import { registryRouter } from './registry.js';
import { callRouter } from '../testing/call-router.js';

describe('/api/registry', () => {
  it('searches the registry for the text asked', async () => {
    const registryService = mock<RegistryService>();
    registryService.search.calledWith('nginx').mockResolvedValue([{ name: 'nginx' }] as never);
    expect((await callRouter(registryRouter({ registryService }), '/api/registry', { path: '/search?q=nginx' })).body).toEqual([{ name: 'nginx' }]);
  });

  it('pages a repository\'s tags, keeping the page, the size and the sort within what is allowed', async () => {
    const registryService = mock<RegistryService>();
    registryService.getTagPage.calledWith('library/nginx', matches<TagPageRequest>((asked) => asked.page === 2 && asked.pageSize === 100 && asked.sort === 'newest')).mockResolvedValue({ tags: ['1.27'], page: 2, pageSize: 100, total: 1, totalPages: 1, sort: 'newest' });
    const answer = await callRouter(registryRouter({ registryService }), '/api/registry', { path: '/tags?repo=library/nginx&page=2&pageSize=5000&sort=sideways' });
    expect(answer.body).toMatchObject({ tags: ['1.27'], page: 2 });
  });

  it('lists the tags a repository has on this machine', async () => {
    const registryService = mock<RegistryService>();
    registryService.getLocalTags.calledWith('library/nginx').mockResolvedValue(['1.27']);
    expect((await callRouter(registryRouter({ registryService }), '/api/registry', { path: '/local-tags?repo=library/nginx' })).body).toEqual(['1.27']);
  });
});
