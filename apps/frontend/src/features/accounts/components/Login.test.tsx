import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../platform/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform/api')>()),
  login: vi.fn(),
  verifyTwoFactor: vi.fn(),
  verifySignUp: vi.fn(),
  resendSignUpCode: vi.fn(),
}));

import Login from './Login.js';
import { login, resendSignUpCode, verifySignUp, verifyTwoFactor } from '../../platform/api';

const mockedLogin = vi.mocked(login);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Login Component', () => {
  it('renders login form by default', () => {
    render(<Login onSuccess={() => {}} />);

    expect(screen.getByRole('heading', { name: /no wrinkles/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('••••••••')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('switches between Sign In and Register views', () => {
    render(<Login onSuccess={() => {}} />);

    const toggleBtn = screen.getByRole('button', { name: /don't have an account yet\? register/i });
    fireEvent.click(toggleBtn);

    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /already have an account\? sign in/i })).toBeInTheDocument();
  });

  it('displays 2FA OTP code panel when requested', async () => {
    mockedLogin.mockResolvedValue({ twoFactorRequired: true, challenge: 'signed-challenge' });

    render(<Login onSuccess={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'test@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText('Two-Factor Authentication')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('e.g. 123456')).toBeInTheDocument();
    });
    expect(mockedLogin).toHaveBeenCalledWith(
      { email: 'test@example.com', password: 'password123' },
      { register: false },
    );
  });

  it('asks for the code when Google or GitHub hands back a sign-in that needs it, and sends its challenge', async () => {
    window.history.replaceState({}, '', '/?twoFactor=from-provider');
    const user = { id: 'u1', email: 'test@example.com' };
    vi.mocked(verifyTwoFactor).mockResolvedValue({ user });
    const onSuccess = vi.fn();
    render(<Login onSuccess={onSuccess} />);

    expect(await screen.findByText('Two-Factor Authentication')).toBeInTheDocument();
    expect(window.location.search).toBe('');
    fireEvent.change(screen.getByPlaceholderText('e.g. 123456'), { target: { value: '424242' } });
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));
    await waitFor(() => expect(verifyTwoFactor).toHaveBeenCalledWith({ challenge: 'from-provider', code: '424242' }));
    expect(onSuccess).toHaveBeenCalledWith(user);
  });

  it('calls onSuccess with the user on a plain successful sign-in', async () => {
    const user = { id: 'u1', email: 'test@example.com' };
    mockedLogin.mockResolvedValue({ user });

    const onSuccess = vi.fn();
    render(<Login onSuccess={onSuccess} />);

    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'test@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith(user);
    });
  });

  const signUpAs = async (email: string) => {
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: email } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    return screen.findByText('Confirm your email');
  };

  it('asks for the emailed code after signing up, and signs in once it is right', async () => {
    const user = { id: 'u2', email: 'new@example.com' };
    mockedLogin.mockResolvedValue({ verify: 'pending-1' });
    vi.mocked(verifySignUp).mockResolvedValue({ user });
    const onSuccess = vi.fn();
    render(<Login onSuccess={onSuccess} invite={{ code: 'INVITE' }} />);

    await signUpAs('new@example.com');
    expect(mockedLogin).toHaveBeenCalledWith({ email: 'new@example.com', password: 'password123', inviteCode: 'INVITE' }, { register: true });
    expect(screen.getByText(/sent a six-digit code to new@example.com/)).toBeInTheDocument();
    expect(screen.queryByText(/here is the code/)).toBeNull();
    const verify = screen.getByRole('button', { name: /^verify/i });
    expect(verify).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Code from the email'), { target: { value: '12a3456' } });
    expect(screen.getByLabelText('Code from the email')).toHaveValue('123456');
    fireEvent.click(verify);
    await waitFor(() => expect(verifySignUp).toHaveBeenCalledWith({ id: 'pending-1', code: '123456' }));
    expect(onSuccess).toHaveBeenCalledWith(user);
  });

  it('shows the code where the server sends no email, sends a new one, and says why a code is refused', async () => {
    mockedLogin.mockResolvedValue({ verify: 'pending-2', devCode: '111111' });
    vi.mocked(resendSignUpCode).mockResolvedValue({ verify: 'pending-2', devCode: '222222' });
    vi.mocked(verifySignUp).mockRejectedValue({ response: { status: 401, data: { error: 'That code is not the one we sent; check the email and try again' } } });
    render(<Login onSuccess={() => {}} invite={{ code: 'INVITE' }} />);

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

  it('goes back to signing up once the sign-up has ended', async () => {
    mockedLogin.mockResolvedValue({ verify: 'pending-3' });
    vi.mocked(verifySignUp).mockRejectedValue({ response: { status: 410, data: { error: 'That code was wrong too many times; sign up again' } } });
    render(<Login onSuccess={() => {}} invite={{ code: 'INVITE' }} />);

    await signUpAs('gone@example.com');
    fireEvent.change(screen.getByLabelText('Code from the email'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: /^verify/i }));
    expect(await screen.findByText('That code was wrong too many times; sign up again')).toBeInTheDocument();
    expect(screen.queryByText('Confirm your email')).toBeNull();
    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
  });

  it('tells the first account to sign in once it is made, since it needs no code', async () => {
    mockedLogin.mockResolvedValue({});
    render(<Login onSuccess={() => {}} invite={{ code: 'SETUP' }} />);
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'owner@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    expect(await screen.findByText('Registration successful! Please sign in.')).toBeInTheDocument();
  });

  it('shows the server error message when sign-in fails', async () => {
    mockedLogin.mockRejectedValue(new Error('Invalid credentials'));

    render(<Login onSuccess={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'test@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText('Invalid credentials')).toBeInTheDocument();
    });
  });
});
