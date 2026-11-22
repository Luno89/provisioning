import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/client', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
  site: {
    post: vi.fn(),
  },
  API_BASE: 'https://koala.test/api',
  SITE_BASE: 'https://koala.test',
}));

import { api, site } from '../../api/client';
import { confirmSecondFactor, getMe, logout, providerSignInUrl, register, resendSignUpCode, signIn, verifySignUp } from './api';

const RESUME = '/oidc/interaction/u1';

const mocked = vi.mocked(api);
const onSite = vi.mocked(site);

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
    mocked.get.mockRejectedValue(Object.assign(new Error('401'), { response: { status: 401 } }));

    await expect(getMe()).resolves.toBeNull();
  });

  it('rejects when the backend did not answer, so a restart is never taken for being signed out', async () => {
    mocked.get.mockRejectedValue(Object.assign(new Error('Network Error'), { response: undefined }));
    await expect(getMe()).rejects.toThrow('Network Error');
    mocked.get.mockRejectedValue(Object.assign(new Error('502'), { response: { status: 502 } }));
    await expect(getMe()).rejects.toThrow('502');
  });
});

describe('logout', () => {
  it('posts to /auth/logout and says where the browser goes to end root\'s session too, or nowhere', async () => {
    mocked.post.mockResolvedValue({ data: { success: true } });
    await expect(logout()).resolves.toBeUndefined();
    expect(mocked.post).toHaveBeenCalledWith('/auth/logout', {});
    mocked.post.mockResolvedValue({ data: { success: true, endSession: 'https://app.example.com/oidc/session/end?id_token_hint=t' } });
    await expect(logout()).resolves.toBe('https://app.example.com/oidc/session/end?id_token_hint=t');
  });
});

describe('signIn', () => {
  it('posts credentials to the sign-in it resumes, on the site beside the API, and unwraps where to go on', async () => {
    onSite.post.mockResolvedValue({ data: { next: 'https://koala.test/oidc/auth/u1' } });

    await expect(signIn(RESUME, { email: 'a@b.c', password: 'pw' })).resolves.toEqual({ next: 'https://koala.test/oidc/auth/u1' });
    expect(onSite.post).toHaveBeenCalledWith('/oidc/interaction/u1/login', { email: 'a@b.c', password: 'pw' });
    expect(mocked.post).not.toHaveBeenCalled();
  });

  it('posts an inviteCode when registering', async () => {
    mocked.post.mockResolvedValue({ data: {} });

    await register({ email: 'a@b.c', password: 'pw', inviteCode: 'INVITE' });
    expect(mocked.post).toHaveBeenCalledWith('/auth/register', {
      email: 'a@b.c',
      password: 'pw',
      inviteCode: 'INVITE',
    });
  });
});

describe('confirming a sign-up', () => {
  it('posts the pending sign-up and its code to the sign-in it resumes, and asks for a new code by the sign-up alone', async () => {
    onSite.post.mockResolvedValueOnce({ data: { next: 'https://koala.test/oidc/auth/u1' } });
    await expect(verifySignUp(RESUME, { id: 'p1', code: '123456' })).resolves.toEqual({ next: 'https://koala.test/oidc/auth/u1' });
    expect(onSite.post).toHaveBeenCalledWith('/oidc/interaction/u1/sign-up/verify', { id: 'p1', code: '123456' });
    mocked.post.mockResolvedValueOnce({ data: { verify: 'p1' } });
    await expect(resendSignUpCode('p1')).resolves.toEqual({ verify: 'p1' });
    expect(mocked.post).toHaveBeenCalledWith('/auth/register/resend', { id: 'p1' });
  });
});

describe('confirmSecondFactor', () => {
  it('posts the code to the sign-in it resumes and unwraps where to go on', async () => {
    onSite.post.mockResolvedValue({ data: { next: 'https://koala.test/oidc/auth/u1' } });

    await expect(confirmSecondFactor(RESUME, '123456')).resolves.toEqual({ next: 'https://koala.test/oidc/auth/u1' });
    expect(onSite.post).toHaveBeenCalledWith('/oidc/interaction/u1/second-factor', { code: '123456' });
  });
});

describe('providerSignInUrl', () => {
  it('starts a provider inside the sign-in it resumes, carrying an invite when there is one', () => {
    expect(providerSignInUrl(RESUME, 'google')).toBe('https://koala.test/oidc/interaction/u1/provider/google');
    expect(providerSignInUrl(RESUME, 'oidc', 'INV ITE')).toBe('https://koala.test/oidc/interaction/u1/provider/oidc?invite=INV%20ITE');
  });
});
