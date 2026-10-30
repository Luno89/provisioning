export const DEV_INFISICAL_ADMIN_PASSWORD = 'dev-admin-password-1234';

export function infisicalAdminPassword(stored: string | undefined, production: boolean, where: string): string {
  const read = stored?.trim();
  if (read) return read;
  if (production) {
    throw new Error(`Infisical's admin password is not in ${where}. In production Koala never signs in to Infisical with the development password: run scripts/ensure-infisical.sh, which makes one and writes it there`);
  }
  return DEV_INFISICAL_ADMIN_PASSWORD;
}
