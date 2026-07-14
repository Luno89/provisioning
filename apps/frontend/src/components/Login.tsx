import React, { useState } from 'react';
import { Mail, Lock, LogIn, UserPlus, Github, Chrome, ShieldAlert, ArrowRight, ShieldCheck, Phone } from 'lucide-react';

interface LoginProps {
  apiBase: string;
  onSuccess: (user: any) => void;
}

export default function Login({ apiBase, onSuccess }: LoginProps) {
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  
  // 2FA Challenge State
  const [twoFactorRequired, setTwoFactorRequired] = useState(false);
  const [userId, setUserId] = useState('');
  const [otpCode, setOtpCode] = useState('');
  
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const handleNativeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);

    try {
      const endpoint = isRegister ? '/auth/register' : '/auth/login';
      const res = await fetch(`${apiBase}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Authentication failed');
      }

      if (isRegister) {
        setMessage('Registration successful! Please sign in.');
        setIsRegister(false);
        setPassword('');
      } else {
        if (data.twoFactorRequired) {
          setTwoFactorRequired(true);
          setUserId(data.userId);
        } else {
          onSuccess(data.user);
        }
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handle2FAVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch(`${apiBase}/auth/2fa/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId, code: otpCode }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || '2FA code verification failed');
      }

      onSuccess(data.user);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSocialLogin = (provider: 'github' | 'google') => {
    window.location.href = `${apiBase.replace(/\/api$/, '')}/api/auth/${provider}`;
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0d0f14] p-4 relative overflow-hidden font-sans">
      {/* Background Neon Gradients */}
      <div className="absolute top-[-10%] left-[-10%] w-[500px] h-[500px] rounded-full bg-violet-600/10 blur-[120px]" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[500px] h-[500px] rounded-full bg-cyan-500/10 blur-[120px]" />

      {/* Main Glass Card */}
      <div className="w-full max-w-md bg-[#161a22]/60 backdrop-blur-xl border border-white/5 rounded-3xl p-8 shadow-2xl relative z-10">
        
        {/* Branding Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-gradient-to-tr from-violet-600 to-cyan-500 mb-4 shadow-lg shadow-violet-600/20">
            <ShieldCheck className="w-6 h-6 text-white" />
          </div>
          <h2 className="text-3xl font-extrabold text-white tracking-tight">IANTHE</h2>
          <p className="text-[#8c94a6] text-sm mt-1">Infrastructure Aggregator and Node Tool for Homelab Environments</p>
        </div>

        {/* Status / Error Alerts */}
        {error && (
          <div className="mb-6 p-4 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-start gap-3">
            <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {message && (
          <div className="mb-6 p-4 rounded-2xl bg-green-500/10 border border-green-500/20 text-green-400 text-sm flex items-start gap-3">
            <ShieldCheck className="w-5 h-5 shrink-0 mt-0.5" />
            <span>{message}</span>
          </div>
        )}

        {/* 2FA Form Panel */}
        {twoFactorRequired ? (
          <form onSubmit={handle2FAVerify} className="space-y-6">
            <div className="text-center mb-4">
              <h3 className="text-lg font-bold text-white">Two-Factor Authentication</h3>
              <p className="text-xs text-[#8c94a6] mt-1">
                Enter the 6-digit OTP code sent to your configured Email or Phone.
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#8c94a6] uppercase tracking-wider mb-2">
                One-Time Password Code
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Phone className="h-5 w-5 text-gray-500" />
                </div>
                <input
                  type="text"
                  required
                  placeholder="e.g. 123456"
                  maxLength={6}
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value)}
                  className="block w-full pl-12 pr-4 py-3.5 bg-[#1f2430]/50 border border-white/5 rounded-2xl text-white placeholder-gray-500 focus:outline-none focus:border-violet-500 transition-colors"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-3.5 px-4 bg-gradient-to-r from-violet-600 to-cyan-500 hover:from-violet-500 hover:to-cyan-400 text-white font-bold rounded-2xl transition-all shadow-lg shadow-violet-600/20 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Verifying...' : 'Verify & Continue'}
              <ArrowRight className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={() => {
                setTwoFactorRequired(false);
                setError('');
              }}
              className="w-full text-center text-xs text-[#8c94a6] hover:text-white transition-colors cursor-pointer"
            >
              Cancel and Return to Sign In
            </button>
          </form>
        ) : (
          /* Sign In / Sign Up Form */
          <>
            <form onSubmit={handleNativeSubmit} className="space-y-6">
              <div>
                <label className="block text-xs font-semibold text-[#8c94a6] uppercase tracking-wider mb-2">
                  Email Address
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <Mail className="h-5 w-5 text-gray-500" />
                  </div>
                  <input
                    type="email"
                    required
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="block w-full pl-12 pr-4 py-3.5 bg-[#1f2430]/50 border border-white/5 rounded-2xl text-white placeholder-gray-500 focus:outline-none focus:border-violet-500 transition-colors"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#8c94a6] uppercase tracking-wider mb-2">
                  Password
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <Lock className="h-5 w-5 text-gray-500" />
                  </div>
                  <input
                    type="password"
                    required
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="block w-full pl-12 pr-4 py-3.5 bg-[#1f2430]/50 border border-white/5 rounded-2xl text-white placeholder-gray-500 focus:outline-none focus:border-violet-500 transition-colors"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 py-3.5 px-4 bg-gradient-to-r from-violet-600 to-cyan-500 hover:from-violet-500 hover:to-cyan-400 text-white font-bold rounded-2xl transition-all shadow-lg shadow-violet-600/20 cursor-pointer disabled:opacity-50"
              >
                {loading ? 'Please wait...' : isRegister ? 'Create Account' : 'Sign In'}
                {isRegister ? <UserPlus className="w-5 h-5" /> : <LogIn className="w-5 h-5" />}
              </button>
            </form>

            {/* Social Logins Splitter */}
            <div className="relative my-8 text-center">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-white/5" />
              </div>
              <span className="relative px-4 bg-[#161a22] text-[#8c94a6] text-xs uppercase tracking-wider">
                Or continue with
              </span>
            </div>

            {/* Social Social Buttons */}
            <div className="grid grid-cols-2 gap-4">
              <button
                onClick={() => handleSocialLogin('github')}
                className="flex items-center justify-center gap-2 py-3 px-4 bg-[#1f2430]/40 border border-white/5 rounded-2xl text-white hover:bg-[#1f2430]/80 transition-colors cursor-pointer"
              >
                <Github className="w-5 h-5" />
                <span className="text-sm font-semibold">GitHub</span>
              </button>
              <button
                onClick={() => handleSocialLogin('google')}
                className="flex items-center justify-center gap-2 py-3 px-4 bg-[#1f2430]/40 border border-white/5 rounded-2xl text-white hover:bg-[#1f2430]/80 transition-colors cursor-pointer"
              >
                <Chrome className="w-5 h-5 text-red-500" />
                <span className="text-sm font-semibold">Google</span>
              </button>
            </div>

            {/* Switch Mode Toggle */}
            <div className="mt-8 text-center">
              <button
                onClick={() => {
                  setIsRegister(!isRegister);
                  setError('');
                  setMessage('');
                }}
                className="text-sm text-[#8c94a6] hover:text-white transition-colors cursor-pointer"
              >
                {isRegister
                  ? 'Already have an account? Sign In'
                  : "Don't have an account yet? Register"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
