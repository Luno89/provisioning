import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./client', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

import { api } from './client';
import { getMe, logout, login, verifyTwoFactor } from './auth';

const mocked = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getMe', () => {
  it('resolves with the signed-in user', async () => {
    mocked.get.mockResolvedValue({ data: { id: 'u1', email: 'a@b.c' } });

    await expect(getMe()).resolves.toEqual({ id: 'u1', email: 'a@b.c' });
    expect(mocked.get).toHaveBeenCalledWith('/auth/me');
  });

  it('resolves null — not a rejection — when nobody is signed in', async () => {
    mocked.get.mockRejectedValue(new Error('401'));

    await expect(getMe()).resolves.toBeNull();
  });
});

describe('logout', () => {
  it('posts to /auth/logout and resolves undefined', async () => {
    mocked.post.mockResolvedValue({ data: {} });

    await expect(logout()).resolves.toBeUndefined();
    expect(mocked.post).toHaveBeenCalledWith('/auth/logout', {});
  });
});

describe('login', () => {
  it('posts credentials to /auth/login and unwraps data on success', async () => {
    const user = { id: 'u1', email: 'a@b.c' };
    mocked.post.mockResolvedValue({ data: { user } });

    await expect(login({ email: 'a@b.c', password: 'pw' })).resolves.toEqual({ user });
    expect(mocked.post).toHaveBeenCalledWith('/auth/login', { email: 'a@b.c', password: 'pw' });
  });

  it('posts an inviteCode when registering', async () => {
    mocked.post.mockResolvedValue({ data: {} });

    await login({ email: 'a@b.c', password: 'pw', inviteCode: 'INVITE' }, { register: true });
    expect(mocked.post).toHaveBeenCalledWith('/auth/register', {
      email: 'a@b.c',
      password: 'pw',
      inviteCode: 'INVITE',
    });
  });
});

describe('verifyTwoFactor', () => {
  it('posts userId and code to /auth/2fa/verify and unwraps data', async () => {
    const user = { id: 'u1', email: 'a@b.c' };
    mocked.post.mockResolvedValue({ data: { user } });

    await expect(verifyTwoFactor({ userId: 'u1', code: '123456' })).resolves.toEqual({ user });
    expect(mocked.post).toHaveBeenCalledWith('/auth/2fa/verify', { userId: 'u1', code: '123456' });
  });
});
