import { describe, expect, it } from 'vitest';
import { encryptValue } from '../../platform/lib/crypto.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { UnreadableCredential } from './CredentialService.js';
import { savedHuggingFaceTokenOf } from './hugging-face-token.js';

const KEY = 'test-key-that-is-at-least-32-characters-long';

describe('a person\'s saved Hugging Face token', () => {
  it('is unsealed for its owner, and none for someone who saved none or for no one', async () => {
    const db = memoryDatabase();
    await db.accounts.saveUser({ id: 'ann', email: 'ann@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: 'x', credentials: { huggingface: { hfToken: encryptValue('hf_saved', KEY) } } });
    await db.accounts.saveUser({ id: 'bob', email: 'bob@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: 'x' });
    const saved = savedHuggingFaceTokenOf(db.accounts, KEY);
    expect(await saved('ann')).toBe('hf_saved');
    expect(await saved('bob')).toBeUndefined();
    expect(await saved(undefined)).toBeUndefined();
  });

  it('cannot be read when it was sealed under another key, and says so', async () => {
    const db = memoryDatabase();
    await db.accounts.saveUser({ id: 'ann', email: 'ann@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: 'x', credentials: { huggingface: { hfToken: encryptValue('hf_saved', 'another-key-that-is-at-least-32-characters') } } });
    await expect(savedHuggingFaceTokenOf(db.accounts, KEY)('ann')).rejects.toBeInstanceOf(UnreadableCredential);
  });
});
