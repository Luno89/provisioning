export function mockOAuthAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
}
