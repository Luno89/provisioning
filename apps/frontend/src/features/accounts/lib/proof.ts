import type { ConfirmWith } from '../../platform'
import type { Proof } from '../types'

export const PASSWORD_SHORTEST = 12

export const proofAsked = (confirmWith: ConfirmWith | undefined): string => {
  if (confirmWith === 'password') return 'Your password'
  if (confirmWith === 'email-code') return 'The code we email you'
  return 'A code from your two-factor sign-in'
}

export const sendsCode = (confirmWith: ConfirmWith | undefined): boolean => confirmWith !== 'password'

export const proofReady = (confirmWith: ConfirmWith | undefined, proof: Proof): boolean =>
  sendsCode(confirmWith) ? /^\d{6}$/.test(proof.code?.trim() ?? '') : Boolean(proof.password)

export const proofSent = (confirmWith: ConfirmWith | undefined, proof: Proof): Proof =>
  sendsCode(confirmWith) ? { code: proof.code?.trim() ?? '' } : { password: proof.password ?? '' }

export function newPasswordProblem(password: string, repeated: string): string | undefined {
  if ([...password].length < PASSWORD_SHORTEST) return `Use at least ${PASSWORD_SHORTEST} characters`
  if (password !== repeated) return 'The two passwords are not the same'
  return undefined
}
