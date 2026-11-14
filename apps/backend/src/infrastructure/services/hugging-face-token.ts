import { decryptValue, type CloudCredentials, type Database, type SecretKey } from '../../platform/index.js';
import { UnreadableCredential } from './CredentialService.js';

export function savedHuggingFaceToken(credentials: CloudCredentials | undefined, key: SecretKey): string | undefined {
  const sealed = credentials?.huggingface?.hfToken;
  if (!sealed) return undefined;
  try {
    return decryptValue(sealed, key);
  } catch {
    throw new UnreadableCredential('huggingface', 'hfToken');
  }
}

export const savedHuggingFaceTokenOf = (accounts: Pick<Database['accounts'], 'getUserById'>, key: SecretKey) =>
  async (ownerId: string | undefined): Promise<string | undefined> =>
    (ownerId ? savedHuggingFaceToken((await accounts.getUserById(ownerId))?.credentials, key) : undefined);
