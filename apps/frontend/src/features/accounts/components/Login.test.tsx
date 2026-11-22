import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { replacedLocation } from '../../../test/location';

vi.mock('../../platform/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform/api')>()),
  register: vi.fn(),
  signIn: vi.fn(),
  confirmSecondFactor: vi.fn(),
  verifySignUp: vi.fn(),
  resendSignUpCode: vi.fn(),
  signInPlace: vi.fn(),
}));

import Login from './Login.js';
import { confirmSecondFactor, register, resendSignUpCode, signIn, signInPlace, verifySignUp } from '../../platform/api';

const RESUME = '/oidc/interaction/u1';
const START = '/api/auth/oidc/start';
const NEXT = 'http://localhost/oidc/auth/u1';

const showLogin = (invite?: string) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Login resume={RESUME} start={START} {...(invite ? { invite: { code: invite } } : {})} />
  </QueryClientProvider>,
);

const typed = (email: string, password: string, button: RegExp) => {
  fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: email } });
  fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: button }));
};

const signsInAs = (email: string, password = 'password123') => typed(email, password, /sign in/i);

const mockedSignIn = vi.mocked(signIn);
const mockedRegister = vi.mocked(register);

const stood = replacedLocation();
const { went, assign } = stood;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(signInPlace).mockResolvedValue({ url: START, providers: [] });
  stood.install();
});

afterEach(() => {
  stood.restore();
});

describe('Login Component', () => {
  it('renders login form by default', () => {
    showLogin();

    expect(screen.getByRole('heading', { name: /no wrinkles/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('••••••••')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('switches between Sign In and Register views', () => {
    showLogin();

    const toggleBtn = screen.getByRole('button', { name: /don't have an account yet\? register/i });
    fireEvent.click(toggleBtn);

    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /already have an account\? sign in/i })).toBeInTheDocument();
  });

  it('displays 2FA OTP code panel when requested', async () => {
    mockedSignIn.mockResolvedValue({ twoFactorRequired: true });

    showLogin();
    signsInAs('test@example.com');

    await waitFor(() => {
      expect(screen.getByText('Two-Factor Authentication')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('e.g. 123456')).toBeInTheDocument();
    });
    expect(mockedSignIn).toHaveBeenCalledWith(RESUME, { email: 'test@example.com', password: 'password123' });
  });

  it('asks for the code when Google or GitHub hands back a sign-in that needs it, and sends it for this sign-in', async () => {
    window.history.replaceState({}, '', `/?resume=${encodeURIComponent(RESUME)}&secondFactor=1`);
    vi.mocked(confirmSecondFactor).mockResolvedValue({ next: NEXT });
    showLogin();

    expect(await screen.findByText('Two-Factor Authentication')).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).has('secondFactor')).toBe(false);
    expect(new URLSearchParams(window.location.search).get('resume')).toBe(RESUME);
    fireEvent.change(screen.getByPlaceholderText('e.g. 123456'), { target: { value: '424242' } });
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));
    await waitFor(() => expect(confirmSecondFactor).toHaveBeenCalledWith(RESUME, '424242'));
    expect(assign).toHaveBeenCalledWith(NEXT);
  });

  it('goes on where root says on a plain successful sign-in', async () => {
    mockedSignIn.mockResolvedValue({ next: NEXT });

    showLogin();
    signsInAs('test@example.com');

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(NEXT);
    });
  });

  it('never goes on to an address that is not a web page', async () => {
    mockedSignIn.mockResolvedValue({ next: 'javascript:alert(1)' });
    showLogin();
    signsInAs('test@example.com');
    expect(await screen.findByText('The sign-in answered without saying where to go on; sign in again')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('starts the sign-in again once root says this one has ended', async () => {
    mockedSignIn.mockRejectedValue({ response: { status: 410, data: { error: 'This sign-in has ended; sign in again' } } });
    showLogin();
    signsInAs('test@example.com');
    await waitFor(() => expect(assign).toHaveBeenCalledWith(START));
  });

  const signUpAs = async (email: string) => {
    typed(email, 'password123', /create account/i);
    return screen.findByText('Confirm your email');
  };

  it('asks for the emailed code after signing up, and signs in once it is right', async () => {
    mockedRegister.mockResolvedValue({ verify: 'pending-1' });
    vi.mocked(verifySignUp).mockResolvedValue({ next: NEXT });
    showLogin('INVITE');

    await signUpAs('new@example.com');
    expect(mockedRegister).toHaveBeenCalledWith({ email: 'new@example.com', password: 'password123', inviteCode: 'INVITE' });
    expect(screen.getByText(/sent a six-digit code to new@example.com/)).toBeInTheDocument();
    expect(screen.queryByText(/here is the code/)).toBeNull();
    const verify = screen.getByRole('button', { name: /^verify/i });
    expect(verify).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Code from the email'), { target: { value: '12a3456' } });
    expect(screen.getByLabelText('Code from the email')).toHaveValue('123456');
    fireEvent.click(verify);
    await waitFor(() => expect(verifySignUp).toHaveBeenCalledWith(RESUME, { id: 'pending-1', code: '123456' }));
    expect(assign).toHaveBeenCalledWith(NEXT);
  });

  it('shows the code where the server sends no email, sends a new one, and says why a code is refused', async () => {
    mockedRegister.mockResolvedValue({ verify: 'pending-2', devCode: '111111' });
    vi.mocked(resendSignUpCode).mockResolvedValue({ verify: 'pending-2', devCode: '222222' });
    vi.mocked(verifySignUp).mockRejectedValue({ response: { status: 401, data: { error: 'That code is not the one we sent; check the email and try again' } } });
    showLogin('INVITE');

    await signUpAs('dev@example.com');
    expect(screen.getByText('This server sends no email, so here is the code: 111111')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /send a new code/i }));
    expect(await screen.findByText('This server sends no email, so here is the code: 222222')).toBeInTheDocument();
    expect(screen.getByText('We sent a new code to dev@example.com.')).toBeInTheDocument();
    expect(resendSignUpCode).toHaveBeenCalledWith('pending-2');
    fireEvent.change(screen.getByLabelText('Code from the email'), { target: { value: '999999' } });
    fireEvent.click(screen.getByRole('button', { name: /^verify/i }));
    expect(await screen.findByText('That code is not the one we sent; check the email and try again')).toBeInTheDocument();
    expect(screen.getByText('Confirm your email')).toBeInTheDocument();
  });

  it('starts again once the sign-up has ended', async () => {
    mockedRegister.mockResolvedValue({ verify: 'pending-3' });
    vi.mocked(verifySignUp).mockRejectedValue({ response: { status: 410, data: { error: 'That code was wrong too many times; sign up again' } } });
    showLogin('INVITE');

    await signUpAs('gone@example.com');
    fireEvent.change(screen.getByLabelText('Code from the email'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: /^verify/i }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(START));
  });

  it('goes back to signing up once a new code can no longer be sent', async () => {
    mockedRegister.mockResolvedValue({ verify: 'pending-4' });
    vi.mocked(resendSignUpCode).mockRejectedValue({ response: { status: 410, data: { error: 'This sign-up has ended; sign up again' } } });
    showLogin('INVITE');

    await signUpAs('gone@example.com');
    fireEvent.click(screen.getByRole('button', { name: /send a new code/i }));
    expect(await screen.findByText('This sign-up has ended; sign up again')).toBeInTheDocument();
    expect(screen.queryByText('Confirm your email')).toBeNull();
    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
  });

  it('tells the first account to sign in once it is made, since it needs no code', async () => {
    mockedRegister.mockResolvedValue({});
    showLogin('SETUP');
    typed('owner@example.com', 'password123', /create account/i);
    expect(await screen.findByText('Registration successful! Please sign in.')).toBeInTheDocument();
  });

  it('shows the server error message when sign-in fails', async () => {
    mockedSignIn.mockRejectedValue(new Error('Invalid credentials'));

    showLogin();
    signsInAs('test@example.com', 'wrong-password');

    await waitFor(() => {
      expect(screen.getByText('Invalid credentials')).toBeInTheDocument();
    });
  });

  it('shows why a provider turned the person away', async () => {
    window.history.replaceState({}, '', `/?resume=${encodeURIComponent(RESUME)}&authError=${encodeURIComponent('That Google account has no invite')}`);
    showLogin();
    expect(await screen.findByText('That Google account has no invite')).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).has('authError')).toBe(false);
    expect(new URLSearchParams(window.location.search).get('resume')).toBe(RESUME);
  });

  it('offers no provider when the server has none configured', async () => {
    showLogin();
    await waitFor(() => expect(signInPlace).toHaveBeenCalled());
    expect(screen.queryByText(/or continue with/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /google|github/i })).toBeNull();
  });

  it('says other ways to sign in could not be loaded, without saying why', async () => {
    vi.mocked(signInPlace).mockRejectedValue(new Error('Request failed with status code 500: database is away'));
    showLogin();
    expect(await screen.findByText('Other ways to sign in could not be loaded. Reload the page to try again.')).toBeInTheDocument();
    expect(screen.queryByText(/database is away/)).toBeNull();
  });

  it('offers only the providers the server says it has, and starts one in this sign-in with the invite when signing up', async () => {
    vi.mocked(signInPlace).mockResolvedValue({ url: START, providers: [{ id: 'google', label: 'Google' }, { id: 'oidc', label: 'Example Co' }] });
    showLogin('INV ITE');
    expect(await screen.findByRole('button', { name: 'Example Co' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Google' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'GitHub' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Example Co' }));
    expect(went).toHaveBeenCalledWith(expect.stringMatching(/\/oidc\/interaction\/u1\/provider\/oidc\?invite=INV%20ITE$/));
  });
});
