import { useState } from 'react'
import { ArrowRight, KeyRound, Lock, Mail } from 'lucide-react'
import { errorMessage } from '../../../api/client'
import { newPasswordProblem, useForgotPassword, useResendPasswordReset, useResetPassword } from '../shared'

export interface ForgotPasswordProps {
  email: string
  onReset: (message: string) => void
  onBack: () => void
}

const field = 'block w-full pl-12 pr-4 py-3.5 bg-[#1f2430]/50 border border-white/5 rounded-2xl text-white placeholder-gray-500 focus:outline-none focus:border-violet-500 transition-colors'
const label = 'block text-xs font-semibold text-[#8c94a6] uppercase tracking-wider mb-2'
const primary = 'w-full flex items-center justify-center gap-2 py-3.5 px-4 bg-gradient-to-r from-violet-600 to-cyan-500 hover:from-violet-500 hover:to-cyan-400 text-white font-bold rounded-2xl transition-all shadow-lg shadow-violet-600/20 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed'
const quiet = 'text-[#8c94a6] hover:text-white transition-colors cursor-pointer disabled:opacity-50'

const gone = (err: unknown): boolean => (err as { response?: { status?: number } }).response?.status === 410

export default function ForgotPassword({ email: first, onReset, onBack }: ForgotPasswordProps) {
  const [email, setEmail] = useState(first)
  const [resetId, setResetId] = useState('')
  const [devCode, setDevCode] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [repeated, setRepeated] = useState('')
  const [note, setNote] = useState('')
  const forgot = useForgotPassword()
  const resend = useResendPasswordReset()
  const reset = useResetPassword()
  const weak = newPasswordProblem(password, repeated)
  const failure = reset.error ?? resend.error ?? forgot.error

  const started = (answer: { reset: string; devCode?: string }) => {
    setResetId(answer.reset)
    setDevCode(answer.devCode ?? '')
    setCode('')
  }
  const startAgain = () => {
    setResetId('')
    setDevCode('')
    setNote('')
  }

  return (
    <div className="space-y-6" data-testid="forgot-password">
      <div className="text-center">
        <h3 className="text-lg font-bold text-white">Reset your password</h3>
        <p className="text-xs text-[#8c94a6] mt-1">
          {resetId
            ? `If ${email} has an account, we sent it a six-digit code. Enter it with your new password; resetting signs you out everywhere.`
            : 'Enter the address you sign in with, and we email you a code to choose a new password.'}
        </p>
        {devCode && <p className="text-xs text-amber-300 mt-2">This server sends no email, so here is the code: {devCode}</p>}
        {note && <p className="text-xs text-green-400 mt-2">{note}</p>}
      </div>

      {failure && <div role="alert" className="p-4 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{errorMessage(failure)}</div>}

      {!resetId ? (
        <form className="space-y-6" onSubmit={(event) => { event.preventDefault(); forgot.mutate(email, { onSuccess: started }) }}>
          <div>
            <label htmlFor="reset-email" className={label}>Email address</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none"><Mail className="h-5 w-5 text-gray-500" /></div>
              <input id="reset-email" type="email" required placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.target.value)} className={field} />
            </div>
          </div>
          <button type="submit" disabled={forgot.isPending} className={primary}>
            {forgot.isPending ? 'Sending…' : 'Email me a code'}
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>
      ) : (
        <form
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault()
            reset.mutate({ id: resetId, code, password }, {
              onSuccess: () => onReset('Your password is changed and every session of your account is signed out. Sign in with your new password.'),
              onError: (err) => { if (gone(err)) startAgain() },
            })
          }}
        >
          <div>
            <label htmlFor="reset-code" className={label}>Code from the email</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none"><KeyRound className="h-5 w-5 text-gray-500" /></div>
              <input id="reset-code" type="text" inputMode="numeric" autoComplete="one-time-code" required placeholder="123456" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} className={field} />
            </div>
          </div>
          <div>
            <label htmlFor="reset-password" className={label}>New password</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none"><Lock className="h-5 w-5 text-gray-500" /></div>
              <input id="reset-password" type="password" autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} className={field} />
            </div>
          </div>
          <div>
            <label htmlFor="reset-repeated" className={label}>New password again</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none"><Lock className="h-5 w-5 text-gray-500" /></div>
              <input id="reset-repeated" type="password" autoComplete="new-password" required value={repeated} onChange={(event) => setRepeated(event.target.value)} className={field} />
            </div>
            <p className="text-xs text-[#8c94a6] mt-2">{password && weak ? weak : 'At least twelve characters, and not one leaked from another site.'}</p>
          </div>
          <button type="submit" disabled={reset.isPending || code.length !== 6 || Boolean(weak)} className={primary}>
            {reset.isPending ? 'Resetting…' : 'Reset password'}
            <ArrowRight className="w-4 h-4" />
          </button>
          <div className="flex justify-between text-xs">
            <button
              type="button"
              className={quiet}
              disabled={resend.isPending}
              onClick={() => resend.mutate(resetId, {
                onSuccess: (answer) => { started(answer); setNote(`We sent a new code, if ${email} has an account.`) },
                onError: (err) => { if (gone(err)) startAgain() },
              })}
            >
              Send a new code
            </button>
            <button type="button" className={quiet} onClick={startAgain}>Use another address</button>
          </div>
        </form>
      )}

      <button type="button" onClick={onBack} className="w-full text-center text-xs text-[#8c94a6] hover:text-white transition-colors cursor-pointer">
        Back to sign in
      </button>
    </div>
  )
}
