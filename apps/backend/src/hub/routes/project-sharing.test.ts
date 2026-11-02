import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ProjectSharingService, SharingOutcome } from '../../projects/index.js';
import { callRouter } from '../testing/call-router.js';
import { projectSharingRouter } from './project-sharing.js';

const ann = { id: 'ann', email: 'ann@example.com' };
const ok = <T>(value: T): SharingOutcome<T> => ({ ok: true, value });

function site() {
  const sharing = mock<ProjectSharingService>();
  const router = projectSharingRouter({ sharing });
  const call = (route: Parameters<typeof callRouter>[2]) => callRouter(router, '/api/project-sharing', { user: ann, ...route });
  return { sharing, call };
}

describe('/api/project-sharing', () => {
  it('says what sharing a project would send and keep', async () => {
    const { sharing, call } = site();
    sharing.preview.calledWith('ann', 'p1').mockResolvedValue(ok({ goes: ['the board'] } as never));
    expect(await call({ path: '/p1' })).toMatchObject({ status: 200, body: { goes: ['the board'] } });
  });

  it('checks a group name as typed', async () => {
    const { sharing, call } = site();
    sharing.groupCheck.mockResolvedValue(ok({ ok: true } as never));
    await call({ path: '/p1/group-check?name=acme' });
    expect(sharing.groupCheck).toHaveBeenCalledWith('ann', 'p1', 'acme');
    await call({ path: '/p1/group-check' });
    expect(sharing.groupCheck).toHaveBeenLastCalledWith('ann', 'p1', undefined);
  });

  it('shares a project as the person under the group they named', async () => {
    const { sharing, call } = site();
    sharing.share.mockResolvedValue(ok({ hubProjectId: 'abc' } as never));
    expect(await call({ method: 'POST', path: '/p1', json: { group: 'acme' } })).toMatchObject({ status: 200, body: { hubProjectId: 'abc' } });
    expect(sharing.share).toHaveBeenCalledWith(ann, 'p1', 'acme');
  });

  it('takes a project back by the name typed', async () => {
    const { sharing, call } = site();
    sharing.takeBack.mockResolvedValue(ok({ taken: true } as never));
    await call({ method: 'DELETE', path: '/p1', json: { confirm: 'Shop' } });
    expect(sharing.takeBack).toHaveBeenCalledWith('ann', 'p1', 'Shop');
  });

  it('answers with the reason and status when sharing is refused', async () => {
    const { sharing, call } = site();
    sharing.share.mockResolvedValue({ ok: false, status: 409, why: 'that group is taken' });
    expect(await call({ method: 'POST', path: '/p1', json: { group: 'acme' } })).toMatchObject({ status: 409, body: { error: 'that group is taken' } });
  });
});
