import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Login from './Login.js';

describe('Login Component', () => {
  it('renders login form by default', () => {
    render(<Login apiBase="http://localhost:3001/api" onSuccess={() => {}} />);

    expect(screen.getByRole('heading', { name: /ianthe/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('••••••••')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('switches between Sign In and Register views', () => {
    render(<Login apiBase="http://localhost:3001/api" onSuccess={() => {}} />);

    const toggleBtn = screen.getByRole('button', { name: /don't have an account yet\? register/i });
    fireEvent.click(toggleBtn);

    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /already have an account\? sign in/i })).toBeInTheDocument();
  });

  it('displays 2FA OTP code panel when requested', async () => {
    // Stub global fetch
    const mockResponse = { twoFactorRequired: true, userId: 'user-123' };
    const globalFetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as any)
    );

    render(<Login apiBase="http://localhost:3001/api" onSuccess={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'test@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText('Two-Factor Authentication')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('e.g. 123456')).toBeInTheDocument();
    });

    globalFetchSpy.mockRestore();
  });
});
