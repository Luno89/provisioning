export const DEV_INFISICAL_ADMIN_PASSWORD = 'dev-admin-password-1234';

export function infisicalAdminPassword(stored: string | undefined, production: boolean, where: string): string {
  const read = stored?.trim();
  if (read) return read;
  if (production) {
    throw new Error(`Infisical's admin password is not in ${where}. In production Koala never signs in to Infisical with the development password: the platform services step, which runs after every install and upgrade of this Koala, makes one there`);
  }
  return DEV_INFISICAL_ADMIN_PASSWORD;
}
