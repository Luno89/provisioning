import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../platform/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform/api')>()),
  login: vi.fn(),
  verifyTwoFactor: vi.fn(),
}));

import Login from './Login.js';
import { login, verifyTwoFactor } from '../../platform/api';

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
