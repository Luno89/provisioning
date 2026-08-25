import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Mocked at the API MODULE, not at fetch or axios.
 *
 * The component used to take `apiBase` and stub `globalThis.fetch` — which matched on URL
 * substrings and silently kept passing after the transport changed shape. It now goes through
 * `api/auth`, so the two functions it calls are replaced here and no test knows a URL.
 */
vi.mock('../api/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/auth')>()),
  login: vi.fn(),
  verifyTwoFactor: vi.fn(),
}));

import Login from './Login.js';
import { login } from '../api/auth';

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
    mockedLogin.mockResolvedValue({ twoFactorRequired: true, userId: 'user-123' });

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
