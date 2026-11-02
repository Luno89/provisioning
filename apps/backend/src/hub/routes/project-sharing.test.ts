import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ProjectSharingService, SharingOutcome } from '../../projects/index.js';
import { routesInProcess } from '../../platform/testing/routes.js';
import { projectSharingRouter } from './project-sharing.js';

const ann = { id: 'ann', email: 'ann@example.com' };
const ok = <T>(value: T): SharingOutcome<T> => ({ ok: true, value });

async function site() {
  const sharing = mock<ProjectSharingService>();
  const routes = await routesInProcess({ prefix: '/api/project-sharing', router: () => projectSharingRouter({ sharing }), user: ann });
  return { sharing, routes };
}

describe('/api/project-sharing', () => {
  it('says what sharing a project would send and keep', async () => {
    const { sharing, routes } = await site();
    sharing.preview.calledWith('ann', 'p1').mockResolvedValue(ok({ goes: ['the board'] } as never));
    expect(await routes.get('/api/project-sharing/p1')).toMatchObject({ status: 200, data: { goes: ['the board'] } });
  });

  it('checks a group name as typed', async () => {
    const { sharing, routes } = await site();
    sharing.groupCheck.mockResolvedValue(ok({ ok: true } as never));
    await routes.get('/api/project-sharing/p1/group-check?name=acme');
    expect(sharing.groupCheck).toHaveBeenCalledWith('ann', 'p1', 'acme');
    await routes.get('/api/project-sharing/p1/group-check');
    expect(sharing.groupCheck).toHaveBeenLastCalledWith('ann', 'p1', undefined);
  });

  it('shares a project as the person under the group they named', async () => {
    const { sharing, routes } = await site();
    sharing.share.mockResolvedValue(ok({ hubProjectId: 'abc' } as never));
    expect(await routes.post('/api/project-sharing/p1', { group: 'acme' })).toMatchObject({ status: 200, data: { hubProjectId: 'abc' } });
    expect(sharing.share).toHaveBeenCalledWith(ann, 'p1', 'acme');
  });

  it('takes a project back by the name typed', async () => {
    const { sharing, routes } = await site();
    sharing.takeBack.mockResolvedValue(ok({ taken: true } as never));
    await routes.delete('/api/project-sharing/p1', { body: { confirm: 'Shop' } });
    expect(sharing.takeBack).toHaveBeenCalledWith('ann', 'p1', 'Shop');
  });

  it('answers with the reason and status when sharing is refused', async () => {
    const { sharing, routes } = await site();
    sharing.share.mockResolvedValue({ ok: false, status: 409, why: 'that group is taken' });
    expect(await routes.post('/api/project-sharing/p1', { group: 'acme' })).toMatchObject({ status: 409, data: { error: 'that group is taken' } });
  });
});
