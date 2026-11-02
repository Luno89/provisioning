import type { Router } from 'express';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mockFn } from 'vitest-mock-extended';
import type { Shell } from '../lib/shell.js';
import { nginxRouter } from './nginx.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';

const on = (router: Router) => routesInProcess({ prefix: '/api/nginx', router: () => router, user: PERSON });

const configAt = (content: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'nginx-route-')), 'nginx.conf');
  writeFileSync(path, content);
  return path;
};

describe('/api/nginx', () => {
  it('shows the config file', async () => {
    const answer = await (await on(nginxRouter({ nginxConfPath: configAt('server {}'), shell: mockFn<Shell>() }))).get('/api/nginx/config');
    expect(answer.data).toEqual({ content: 'server {}' });
  });

  it('says why the config cannot be read', async () => {
    const answer = await (await on(nginxRouter({ nginxConfPath: join(tmpdir(), 'no-such-dir-koala', 'nginx.conf'), shell: mockFn<Shell>() }))).get('/api/nginx/config');
    expect(answer.status).toBe(500);
    expect((answer.data as { error: string }).error).toMatch(/^Failed to read nginx config: /);
  });

  it('writes the config and reloads nginx in its container', async () => {
    const path = configAt('old');
    const shell = mockFn<Shell>();
    shell.calledWith('docker exec provisioner-nginx nginx -s reload').mockResolvedValue({ stdout: '', stderr: '' });
    const answer = await (await on(nginxRouter({ nginxConfPath: path, shell }))).post('/api/nginx/config', { content: 'new' });
    expect(answer.data).toEqual({ message: 'Nginx config updated and reloaded successfully' });
    expect(readFileSync(path, 'utf8')).toBe('new');
  });

  it('refuses a config that is not text before it touches the file', async () => {
    const path = configAt('old');
    const shell = mockFn<Shell>();
    const answer = await (await on(nginxRouter({ nginxConfPath: path, shell }))).post('/api/nginx/config', { content: 5 });
    expect(answer.status).toBe(400);
    expect(readFileSync(path, 'utf8')).toBe('old');
    expect(shell).not.toHaveBeenCalled();
  });

  it('says why nginx would not reload', async () => {
    const shell = mockFn<Shell>();
    shell.mockRejectedValue(new Error('nginx: configuration file test failed'));
    const answer = await (await on(nginxRouter({ nginxConfPath: configAt('old'), shell }))).post('/api/nginx/config', { content: 'bad' });
    expect(answer.status).toBe(500);
    expect(answer.data).toEqual({ error: 'Failed to update nginx config: nginx: configuration file test failed' });
  });
});
