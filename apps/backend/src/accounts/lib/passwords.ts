export const PASSWORD_SHORTEST = 12;
export const PASSWORD_LONGEST = 1024;

export interface BreachedPasswords {
  has(password: string): boolean;
}

export const breachedFrom = (text: string): BreachedPasswords => {
  const listed = new Set(text.split('\n').filter((line) => line.length > 0));
  return { has: (password) => listed.has(password.toLowerCase()) };
};

export function passwordProblem(password: unknown, breached: BreachedPasswords, email?: string): string | undefined {
  if (typeof password !== 'string' || !password) return 'Choose a password';
  if ([...password].length < PASSWORD_SHORTEST) return `Use at least ${PASSWORD_SHORTEST} characters for your password`;
  if (password.length > PASSWORD_LONGEST) return `Use at most ${PASSWORD_LONGEST} characters for your password`;
  if (email && password.trim().toLowerCase() === email.trim().toLowerCase()) return 'Your password cannot be your email address';
  if (breached.has(password)) return 'That password is on lists of passwords leaked from other sites; choose another';
  return undefined;
}
